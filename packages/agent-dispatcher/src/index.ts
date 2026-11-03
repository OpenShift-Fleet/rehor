import { readAuthConfig, type AuthConfig } from "./config.js";
import { createCredentialProvider, preflightFailureMessage } from "./preflight.js";
import { readGatewayConfig } from "./gateway-config.js";
import { connectGateway } from "./gateway.js";
import { createLifecycleLogger, writeStartupGreeting } from "./logging.js";
import { parseConfigRepositories } from "./config-repositories.js";
import { runDispatcherLoop } from "./dispatcher-loop.js";

const logger = createLifecycleLogger();
const startup = logger.start("startup");
const keepAlive = setInterval(() => {}, 60_000);
const stopController = new AbortController();
const shutdownDeadlineMs = 25_000;
let shuttingDown = false;
let startPromise: Promise<void>;
let loopPromise: Promise<void> | undefined;

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
  void Promise.all([startPromise, loopPromise]).then(() => {
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
  let authConfig: AuthConfig | undefined;
  let gatewayConfig: ReturnType<typeof readGatewayConfig>;
  const repositoriesJson = process.env.AGENT_DISPATCHER_CONFIG_REPOS;
  const configuration = logger.start("configuration");
  try {
    authConfig = readAuthConfig(process.env);
    if (authConfig) provider = createCredentialProvider(authConfig, {}, logger);
  } catch {
    configuration.failure("configuration");
    startup.failure("configuration");
    fail("Agent dispatcher auth configuration failed");
    return;
  }
  try {
    gatewayConfig = readGatewayConfig(process.env);
    if (repositoriesJson !== undefined) {
      if (!gatewayConfig || !authConfig || !provider || !parseConfigRepositories(repositoriesJson).length) throw new Error();
    }
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
    // Authentication only: connectGateway verifies the gateway and discards
    // its client. The preflight loop must depend on the configuration objects,
    // never on a client value, so it starts exactly when repositories,
    // memory and gateway are all configured and authenticated.
    if (gatewayConfig) await connectGateway(gatewayConfig, logger, stopController.signal);
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
    if (repositoriesJson && gatewayConfig && authConfig && provider) {
      loopPromise = runDispatcherLoop({
        repositoriesJson,
        signal: stopController.signal,
        // Preflight memory requests authenticate with a short-lived minted
        // credential; it is forwarded per cycle, never via the process env.
        memoryCredential: async () => (await provider!.mint()).token,
      });
    }
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
