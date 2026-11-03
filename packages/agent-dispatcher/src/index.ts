import { readAuthConfig, type AuthConfig } from "./config.js";
import { createCredentialProvider, preflightFailureMessage } from "./preflight.js";
import { readGatewayConfig } from "./gateway-config.js";
import { connectGateway } from "./gateway.js";
import { createLifecycleLogger, writeStartupGreeting } from "./logging.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { parseConfigRepositories } from "./config-repositories.js";
import { runDispatcherCycle } from "./dispatcher-cycle.js";
import { SessionDispatcher, type SessionCompletion } from "./dispatch-sessions.js";

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
  let gateway: Awaited<ReturnType<typeof connectGateway>> | undefined;
  try {
    if (gatewayConfig) gateway = await connectGateway(gatewayConfig, logger, stopController.signal);
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
    if (repositoriesJson && gateway && authConfig && provider) {
      loopPromise = runLoop(repositoriesJson);
    }
  }
}

/** Forward only non-secret settings needed by legacy preflights. */
function preflightEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && (name === "PATH" || name === "JIRA_MCP_URL" || name === "EXECUTOR_ADDR" || /^(?:HTTP_PROXY|HTTPS_PROXY|NO_PROXY|http_proxy|https_proxy|no_proxy)$/.test(name) || (/^BOT_[A-Z0-9_]+$/.test(name) && !/(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY)/.test(name)))) env[name] = value;
  }
  return env;
}

async function runLoop(repositoriesJson: string): Promise<void> {
  const sessions = new SessionDispatcher();
  const signal = stopController.signal;
  const cacheRoot = process.env.AGENT_DISPATCHER_CONFIG_DIR || join(tmpdir(), "rehor-agent-dispatcher");
  while (!signal.aborted) {
    try {
      const result = await runDispatcherCycle({
        repositoriesJson, cacheRoot, env: preflightEnvironment(), dispatcher: sessions, signal,
        // Sandbox launch is deliberately not part of this change: the echo probe
        // and real runner dispatch follow in REHOR-226.
        launch: async (): Promise<SessionCompletion> => "not-created",
      });
      if (!signal.aborted) console.log(JSON.stringify({ event: "preflight.cycle", result }));
      await sleep(5 * 60_000, undefined, { signal });
    } catch {
      if (!signal.aborted) {
        console.error("Dispatcher cycle failed");
        try { await sleep(5 * 60_000, undefined, { signal }); } catch { break; }
      }
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
