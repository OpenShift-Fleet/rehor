import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { tmpdir } from "node:os";
import type { AgentProfile } from "./agent-profiles.js";
import { runDispatcherCycle, type DispatcherCycleResult } from "./dispatcher-cycle.js";
import { SessionDispatcher, type SessionCompletion } from "./dispatch-sessions.js";
import { isForwardedPreflightVariable } from "./preflight-env.js";

export type DispatcherLoopOptions = {
  repositoriesJson: string;
  signal?: AbortSignal;
  /** Complete environment for preflights; defaults to the filtered process environment. */
  env?: NodeJS.ProcessEnv;
  /** Sandbox launch for a start decision. Defaults to completing without creating a sandbox. */
  launch?: (profile: AgentProfile, prompt: string) => Promise<SessionCompletion>;
  /** Mints the per-cycle memory credential forwarded to preflight scripts. */
  memoryCredential?: () => Promise<string>;
  /** Observes each completed cycle; defaults to a structured stdout event. */
  onCycle?: (result: DispatcherCycleResult) => void;
  /** Cycle spacing. Defaults to five minutes. */
  intervalMs?: number;
};

/** Forward only non-secret settings needed by legacy preflights. */
export function preflightEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && isForwardedPreflightVariable(name)) env[name] = value;
  }
  return env;
}

/**
 * Repeated dispatcher cycles until aborted. Sessions are not drained here:
 * a retained session (unknown completion) must not hold the loop hostage, and
 * shutdown deadlines remain the caller's responsibility.
 */
export async function runDispatcherLoop(options: DispatcherLoopOptions): Promise<void> {
  const sessions = new SessionDispatcher();
  const signal = options.signal;
  const intervalMs = options.intervalMs ?? 5 * 60_000;
  const cacheRoot = process.env.AGENT_DISPATCHER_CONFIG_DIR || join(tmpdir(), "rehor-agent-dispatcher");
  const emit = options.onCycle ?? ((result) => console.log(JSON.stringify({ event: "preflight.cycle", result })));
  const env = options.env ?? preflightEnvironment();
  const launch = options.launch ?? (async (): Promise<SessionCompletion> => "not-created");
  while (!signal?.aborted) {
    try {
      const result = await runDispatcherCycle({ repositoriesJson: options.repositoriesJson, cacheRoot, env, dispatcher: sessions, signal, launch, memoryCredential: options.memoryCredential });
      if (!signal?.aborted) emit(result);
      await sleep(intervalMs, undefined, { signal });
    } catch {
      if (!signal?.aborted) {
        console.error("Dispatcher cycle failed");
        try { await sleep(intervalMs, undefined, { signal }); } catch { break; }
      }
    }
  }
}
