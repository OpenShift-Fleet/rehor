import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { readAuthConfig, readBotMemoryUrl, readModelProxyUrl, readPublicEgressEnabled, readSandboxRetentionMs, readSessionLockTtlMs, readServiceGatewayUrl, type AuthConfig } from "./config.js";
import { createCredentialProvider, preflightFailureMessage } from "./preflight.js";
import { readGatewayConfig } from "./gateway-config.js";
import { connectGateway } from "./gateway.js";
import { createLifecycleLogger, writeStartupGreeting, type LifecycleEvent, type LogOptions } from "./logging.js";
import { parseConfigRepositories } from "./config-repositories.js";
import { runDispatcherLoop, preflightEnvironment } from "./dispatcher-loop.js";
import { verifyPreflightTools } from "./work-preflight.js";
import { SandboxSession, type SandboxSessionResult } from "./sandbox-session.js";
import { readRuntimeLayout } from "./runtime-layout.js";
import { sandboxEnvironment } from "./runtime-environment.js";
import { createSessionLockClient, withSessionLock, type SessionLockLog } from "./session-lock.js";
import { createSessionRegistryClient, reconcileOpenSessions } from "./session-registry.js";
import type { SessionCompletion } from "./dispatch-sessions.js";

const logger = createLifecycleLogger();
const startup = logger.start("startup");
const keepAlive = setInterval(() => {}, 60_000);
const stopController = new AbortController();
// Each session cleanup has a shared 20-minute deadline, leaving two minutes
// for shutdown bookkeeping. Runtime termination grace must exceed this drain
// deadline (documented in README); no workload manifest lives here to set it.
const shutdownDeadlineMs = 22 * 60_000;
// Startup reconciliation of abandoned sessions is bounded: a hung
// reconciliation must not block the dispatch loop forever, and the loop's
// session lock prevents duplicate sessions either way.
const reconcileBoundMs = 5 * 60_000;
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
  let runtimeLayout: ReturnType<typeof readRuntimeLayout>;
  let modelProxyUrl: URL | undefined;
  let serviceGatewayUrl: URL | undefined;
  let botMemoryUrl: URL | undefined;
  let publicEgress = false;
  let sandboxRetentionMs = 0;
  let sessionLockTtlMs = 0;
  const repositoriesJson = process.env.AGENT_DISPATCHER_CONFIG_REPOS;
  const configuration = logger.start("configuration");
  try {
    authConfig = readAuthConfig(process.env);
    botMemoryUrl = readBotMemoryUrl(process.env, authConfig);
    modelProxyUrl = readModelProxyUrl(process.env);
    serviceGatewayUrl = readServiceGatewayUrl(process.env, authConfig, modelProxyUrl);
    publicEgress = readPublicEgressEnabled(process.env);
    sandboxRetentionMs = readSandboxRetentionMs(process.env);
    sessionLockTtlMs = readSessionLockTtlMs(process.env);
    if (authConfig) provider = createCredentialProvider(authConfig, {}, logger);
  } catch {
    configuration.failure("configuration");
    startup.failure("configuration");
    fail("Agent dispatcher auth configuration failed");
    return;
  }
  try {
    gatewayConfig = readGatewayConfig(process.env);
    runtimeLayout = readRuntimeLayout(process.env);
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
      const session = new SandboxSession({
        raw: gateway.raw,
        memory: { url: authConfig.memoryUrl, credentialProvider: provider },
        runtime: runtimeLayout,
        ...(modelProxyUrl ? { modelProxyUrl } : {}),
        memoryRuntime: !!botMemoryUrl,
        ...(serviceGatewayUrl ? { serviceGatewayUrl } : {}),
        ...(publicEgress ? { publicEgress } : {}),
        sandboxRetentionMs,
        onRetention: (info) => logger.log("sandbox.retention", "success", {
          retentionMs: info.retentionMs, workspaceName: info.workspaceName, sandboxName: info.sandboxName,
        }),
      });
      const signal = stopController.signal;
      const hostEnvironment = preflightEnvironment();
      // Snapshot validated deployment configuration for both execution paths.
      if (botMemoryUrl) hostEnvironment.BOT_MEMORY_URL = botMemoryUrl.href;
      else delete hostEnvironment.BOT_MEMORY_URL;
      // REHOR-218: cluster-wide per-agent session mutex, leased from the
      // memory server. Enabled only when the TTL is positive; without it the
      // launch path below is exactly the pre-mutex behavior.
      const sessionLock = sessionLockTtlMs > 0
        ? createSessionLockClient({ url: authConfig.memoryUrl, mint: async () => (await provider!.mint()).token })
        : undefined;
      // REHOR-218 phase 2: durable session registry. Enabled exactly when the
      // lock is: without the lock there is a single replica and no abandoned
      // sessions of another pod to reconcile. Unlike the lock this is
      // best-effort durability — a registry outage is logged, never fatal.
      const sessionRegistry = sessionLock
        ? createSessionRegistryClient({ url: authConfig.memoryUrl, mint: async () => (await provider!.mint()).token })
        : undefined;
      const lockHolder = hostname();
      // withSessionLock emits only the fixed "sandbox.lock" event with
      // lifecycle-logger-shaped details; the logger re-validates and drops
      // anything malformed, so these narrowing casts stay sound.
      const lockLog: SessionLockLog = (event, status, data) => {
        logger.log(event as LifecycleEvent, status, data as LogOptions);
      };
      if (sessionLock && sessionRegistry) {
        // Reconcile sessions abandoned by dead pods before dispatching new
        // work: adopt or clean up their gateway resources and release their
        // locks. Bounded so startup cannot hang; the shutdown signal aborts
        // it promptly and the next restart retries whatever stayed open.
        const reconciliation = reconcileOpenSessions({
          registry: sessionRegistry,
          lockClient: sessionLock,
          gateway: gateway.raw,
          holder: lockHolder,
          signal,
          log: lockLog,
        }).catch(() => {});
        // The sleep is never cancelled, so a plain then() would emit a
        // spurious startup-timeout minutes after a fast, successful
        // reconcile; only log the bound when reconciliation has not settled.
        let settled = false;
        const bounded = reconciliation.finally(() => { settled = true; });
        const bound = sleep(reconcileBoundMs, undefined, { signal }).then(
          () => { if (!settled) lockLog("sandbox.reconcile", "failure", { reason: "startup-timeout" }); },
          () => {},
        );
        await Promise.race([bounded, bound]);
      }
      loopPromise = runDispatcherLoop({
        repositoriesJson, signal,
        env: hostEnvironment,
        // Preflight memory requests authenticate with a short-lived minted
        // credential; it is forwarded per cycle, never via the process env.
        memoryCredential: async () => (await provider!.mint()).token,
        launch: async (profile, agentId, _prompt, decision) => {
          if (signal.aborted) return "not-created";
          const environment = sandboxEnvironment(hostEnvironment, profile.preflightEnv, serviceGatewayUrl, modelProxyUrl);
          // The run ID is minted here so the registry record can exist before
          // the session starts; the session reuses it for names and labels.
          const runId = randomUUID();
          const registry = sessionRegistry;
          const runSession = async (lockToken?: string): Promise<SessionCompletion> => {
            if (registry) {
              // Best-effort durability: a registry outage is logged and the
              // session continues (the lock above stays fail-closed).
              const registered = await registry.register({
                runId,
                agentId,
                holder: lockHolder,
                ...(lockToken ? { lockToken } : {}),
              });
              if (!registered) lockLog("sandbox.registry", "failure", { register: true });
            }
            // Register before invoking session code, including synchronous errors
            // or a shutdown signal raised during admission.
            const work = Promise.resolve().then(() => registry
              ? session.run(profile.image.reference, decision, environment, signal, {
                runId,
                onProvisioned: async (info) => {
                  await registry.update(runId, {
                    workspaceName: info.workspaceName,
                    sandboxName: info.sandboxName,
                    providerName: info.providerName,
                    profileName: info.profileName,
                  });
                },
              })
              : session.run(profile.image.reference, decision, environment, signal));
            sessionRuns.add(work);
            const running = logger.start("sandbox.session");
            let settled: SandboxSessionResult | undefined;
            try {
              const record = await work;
              settled = record;
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
              if (registry) {
                // The record settles with the session, whatever its outcome;
                // a failed update is logged, never fatal.
                const updated = await registry.update(runId, {
                  state: "completed",
                  ...(settled ? { detail: { outcome: settled.outcome, cleanup: settled.cleanup, completion: settled.completion } } : {}),
                });
                if (!updated) lockLog("sandbox.registry", "failure", { update: true });
              }
            }
          };
          if (!sessionLock) return runSession();
          // Contended (another replica runs the agent) or failed acquisition
          // created nothing: no session ran, so nothing is registered above.
          const outcome = await withSessionLock({
            lock: sessionLock,
            key: `agent-session:${agentId}`,
            holder: lockHolder,
            ttlMs: sessionLockTtlMs,
            log: lockLog,
            run: runSession,
          });
          return outcome.status === "ran" ? outcome.result : "not-created";
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
