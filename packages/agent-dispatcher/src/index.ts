import { readAuthConfig } from "./config.js";
import { createCredentialProvider, preflightFailureMessage } from "./preflight.js";
import { readGatewayConfig } from "./gateway-config.js";
import { connectGateway } from "./gateway.js";
import { createLifecycleLogger, writeStartupGreeting } from "./logging.js";

const logger = createLifecycleLogger();
const startup = logger.start("startup");
const keepAlive = setInterval(() => {}, 60_000);
const stopController = new AbortController();
const shutdownDeadlineMs = 25_000;
let shuttingDown = false;
let startPromise: Promise<void>;

const shutdown = (): void => {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  const stopping = logger.start("shutdown");
  clearInterval(keepAlive);
  process.exitCode = 0;
  stopController.abort();
  const deadline = setTimeout(() => {
    stopping.failure("internal");
    // Pending filesystem or SDK work cannot always be cancelled. Do not claim
    // successful shutdown if it has not drained by the deadline.
    process.exit(1);
  }, shutdownDeadlineMs);
  void startPromise.then(() => {
    clearTimeout(deadline);
    stopping.success();
  }, () => {
    clearTimeout(deadline);
    stopping.failure("internal");
    process.exitCode = 1;
  });
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

async function start(): Promise<void> {
  let provider: ReturnType<typeof createCredentialProvider> | undefined;
  let gatewayConfig: ReturnType<typeof readGatewayConfig>;
  const configuration = logger.start("configuration");
  try {
    const config = readAuthConfig(process.env);
    if (config) provider = createCredentialProvider(config, {}, logger);
  } catch {
    configuration.failure("configuration");
    startup.failure("configuration");
    fail("Agent dispatcher auth configuration failed");
    return;
  }
  try {
    gatewayConfig = readGatewayConfig(process.env);
  } catch {
    configuration.failure("configuration");
    startup.failure("configuration");
    fail("OpenShell gateway configuration failed");
    return;
  }
  configuration.success();
  try {
    if (provider) await provider.get();
  } catch (error) {
    if (shuttingDown) return;
    startup.failure("internal");
    fail(preflightFailureMessage(error));
    return;
  }
  if (shuttingDown) return;
  try {
    if (gatewayConfig) await connectGateway(gatewayConfig, undefined, logger, stopController.signal);
  } catch {
    if (shuttingDown) return;
    startup.failure("internal");
    fail("OpenShell gateway preflight failed");
    return;
  }
  if (!shuttingDown) {
    startup.success();
    logger.log("ready", "success");
    writeStartupGreeting();
  }
}

function fail(message: string): void {
  console.error(message);
  shuttingDown = true;
  const stopping = logger.start("shutdown");
  clearInterval(keepAlive);
  process.exitCode = 1;
  stopping.success();
}

startPromise = start();
