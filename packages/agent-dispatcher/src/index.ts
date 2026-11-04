import { readAuthConfig, type AuthConfig } from "./config.js";
import { createCredentialProvider, preflightFailureMessage } from "./preflight.js";
import { readGatewayConfig } from "./gateway-config.js";
import { connectGateway } from "./gateway.js";
import { createLifecycleLogger, writeStartupGreeting } from "./logging.js";
import { parseConfigRepositories } from "./config-repositories.js";
import { runDispatcherLoop, preflightEnvironment } from "./dispatcher-loop.js";
import { verifyPreflightTools } from "./work-preflight.js";
import { SandboxSession } from "./sandbox-session.js";

const logger = createLifecycleLogger();
const startup = logger.start("startup");
const keepAlive = setInterval(() => {}, 60_000);
const stopController = new AbortController();
// Each session cleanup has a shared 20-minute deadline, leaving two minutes
// for shutdown bookkeeping. Runtime termination grace must exceed this drain
// deadline (documented in README); no workload manifest lives here to set it.
const shutdownDeadlineMs = 22 * 60_000;
let shuttingDown = false;
let startPromise = Promise.resolve();
let loopPromise: Promise<void> | undefined;
const sessionRuns = new Set<Promise<unknown>>();
let unresolvedSessionResult = false;

async function drainOperations(): Promise<void> {
  // Startup may register the loop after shutdown begins. The loop may itself
  // register sessions, so drain in producer order rather than taking a snapshot.
  let failed = false;
  try { await startPromise; } catch { failed = true; }
  try { await loopPromise; } catch { failed = true; }
  while (sessionRuns.size) {
    const results = await Promise.allSettled([...sessionRuns]);
    if (results.some((result) => result.status === "rejected"
      || (result.status === "fulfilled" && isUnresolvedSession(result.value)))) failed = true;
  }
  if (unresolvedSessionResult) failed = true;
  if (failed) throw new Error("Dispatcher operations failed");
}

function isUnresolvedSession(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const result = value as { completion?: unknown; cleanup?: unknown };
  return result.completion === "unknown" || result.cleanup === "unknown";
}

const shutdown = (): void => {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  const stopping = logger.start("shutdown");
  clearInterval(keepAlive);
  process.exitCode ??= 0;
  stopController.abort();
  const deadline = setTimeout(() => {
    stopping.failure("internal");
    // Pending filesystem or SDK work cannot always be cancelled. Do not claim
    // successful shutdown if it has not drained by the deadline.
    process.exit(1);
  }, shutdownDeadlineMs);
  void drainOperations().then(() => {
    clearTimeout(deadline);
    stopping.success();
  }, () => {
    clearTimeout(deadline);
    stopping.failure("internal");
    if (process.exitCode === undefined || process.exitCode === 0) process.exitCode = 1;
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
      // Work preflights execute Python from the base image; config repository
      // synchronization needs Git. Fail startup instead of degrading into
      // undiagnosable per-cycle errors.
      await verifyPreflightTools();
    }
  } catch {
    configuration.failure("configuration");
    startup.failure("configuration");
    fail("Agent dispatcher gateway or preflight tooling configuration failed");
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
    // Authenticate once; production sessions use the connected client.
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
    if (repositoriesJson && gatewayConfig && authConfig && provider && gateway) {
      const session = new SandboxSession(gateway.raw, { url: authConfig.memoryUrl, credentialProvider: provider });
      const signal = stopController.signal;
      loopPromise = runDispatcherLoop({
        repositoriesJson, signal,
        // Preflight memory requests authenticate with a short-lived minted
        // credential; it is forwarded per cycle, never via the process env.
        memoryCredential: async () => (await provider!.mint()).token,
        launch: async (profile, _prompt, decision) => {
          if (signal.aborted) return "not-created";
          const environment: Record<string, string> = {};
          for (const [name, value] of Object.entries({ ...preflightEnvironment(), ...profile.preflightEnv })) {
            if (name !== "PATH" && value !== undefined) environment[name] = value;
          }
          // Register before invoking session code, including synchronous errors
          // or a shutdown signal raised during admission.
          const work = Promise.resolve().then(() => session.run(profile.image.reference, decision, environment, signal));
          sessionRuns.add(work);
          const running = logger.start("sandbox.session");
          try {
            const record = await work;
            if (isUnresolvedSession(record)) unresolvedSessionResult = true;
            if (record.outcome === "passed") running.success();
            else running.failure("internal", { stage: record.stage, errorCode: record.errorCode });
            if (record.cleanup === "deleted") logger.log("sandbox.cleanup", "success");
            else if (record.cleanup === "unknown") logger.log("sandbox.cleanup", "failure", { category: "internal", stage: record.stage, errorCode: record.errorCode });
            return record.completion;
          } catch {
            running.failure("internal");
            logger.log("sandbox.cleanup", "failure", { category: "internal" });
            return "unknown";
          } finally {
            sessionRuns.delete(work);
          }
        },
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
