/** Dispatcher side of the durable session registry and startup reconciliation
 * (REHOR-218 phase 2).
 *
 * The memory server stores one registry record per sandbox session under
 * /api/session-registry (dumb storage; the dispatcher owns every lifecycle
 * transition). The launch path registers a record before the session starts,
 * updates it once gateway resources are provisioned, and marks it completed
 * when the session settles. When a dispatcher pod dies mid-session its
 * replacement lists the open records on startup and reconciles each one:
 * adopt still-running sandboxes until they terminate, clean up terminal or
 * vanished ones, and release the per-agent session lock the dead pod could
 * not. Only fixed identifiers (run IDs, agent IDs, generated resource names)
 * travel in requests; never session content or prompts. */

import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { OpenShellClient } from "@nvidia/openshell-sdk";
import { SandboxPhase } from "@nvidia/openshell-sdk/raw";
import { Code, ConnectError } from "@connectrpc/connect";

export type SessionRegistryRecord = {
  runId: string;
  agentId: string;
  holder: string;
  lockToken: string | null;
  state: string;
  workspaceName: string | null;
  sandboxName: string | null;
  providerName: string | null;
  profileName: string | null;
  startedAt: string;
  updatedAt: string;
  detail: unknown;
};

export type SessionRegistryClient = {
  /** Upsert the open record for a session; false on any failure, never throws. */
  register(input: { runId: string; agentId: string; holder: string; lockToken?: string }): Promise<boolean>;
  /** Patch a record; absent fields stay untouched. False on any failure, never throws. */
  update(
    runId: string,
    fields: {
      state?: string;
      workspaceName?: string;
      sandboxName?: string;
      providerName?: string;
      profileName?: string;
      detail?: unknown;
    },
  ): Promise<boolean>;
  /** All records still marked open; empty array on any failure, never throws. */
  listOpen(): Promise<SessionRegistryRecord[]>;
};

type RegistryJson = Record<string, unknown>;

const asString = (value: unknown): string => (typeof value === "string" ? value : "");
const asNullable = (value: unknown): string | null => (typeof value === "string" && value ? value : null);

function mapRecord(value: unknown): SessionRegistryRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const json = value as RegistryJson;
  // Identity fields are the minimum needed to reconcile a record.
  const runId = asString(json.run_id);
  const agentId = asString(json.agent_id);
  if (!runId || !agentId) return undefined;
  return {
    runId,
    agentId,
    holder: asString(json.holder),
    lockToken: asNullable(json.lock_token),
    state: asString(json.state),
    workspaceName: asNullable(json.workspace_name),
    sandboxName: asNullable(json.sandbox_name),
    providerName: asNullable(json.provider_name),
    profileName: asNullable(json.profile_name),
    startedAt: asString(json.started_at),
    updatedAt: asString(json.updated_at),
    detail: json.detail ?? null,
  };
}

export function createSessionRegistryClient(options: {
  /** Base memory-server URL (authConfig.memoryUrl). */
  url: URL;
  /** Mints the bearer token for each request. */
  mint: () => Promise<string>;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}): SessionRegistryClient {
  const doFetch = options.fetchImpl ?? fetch;
  // Same never-throw transport contract as the session lock client: minting,
  // network, and response-body failures resolve to undefined so callers map
  // them to their error states; an unparsable body still carries its status.
  const request = async (
    path: string,
    init?: { method?: string; body?: RegistryJson },
  ): Promise<{ status: number; json: unknown } | undefined> => {
    try {
      const token = await options.mint();
      const response = await doFetch(new URL(path, options.url), {
        method: init?.method ?? "GET",
        headers: { authorization: `Bearer ${token}`, ...(init?.body ? { "content-type": "application/json" } : {}) },
        ...(init?.body ? { body: JSON.stringify(init.body) } : {}),
      });
      let json: unknown = null;
      try {
        json = await response.json();
      } catch {
        /* Status still decides. */
      }
      return { status: response.status, json };
    } catch {
      return undefined;
    }
  };
  return {
    async register(input) {
      const response = await request("/api/session-registry/register", {
        method: "POST",
        body: {
          run_id: input.runId,
          agent_id: input.agentId,
          holder: input.holder,
          ...(input.lockToken !== undefined ? { lock_token: input.lockToken } : {}),
        },
      });
      if (!response || response.status !== 200) return false;
      return (response.json as { registered?: unknown } | null)?.registered === true;
    },
    async update(runId, fields) {
      const body: RegistryJson = { run_id: runId };
      if (fields.state !== undefined) body.state = fields.state;
      if (fields.workspaceName !== undefined) body.workspace_name = fields.workspaceName;
      if (fields.sandboxName !== undefined) body.sandbox_name = fields.sandboxName;
      if (fields.providerName !== undefined) body.provider_name = fields.providerName;
      if (fields.profileName !== undefined) body.profile_name = fields.profileName;
      if (fields.detail !== undefined) body.detail = fields.detail;
      const response = await request("/api/session-registry/update", { method: "POST", body });
      if (!response || response.status !== 200) return false;
      return (response.json as { updated?: unknown } | null)?.updated === true;
    },
    async listOpen() {
      const response = await request("/api/session-registry?state=open");
      if (!response || response.status !== 200 || !Array.isArray(response.json)) return [];
      return response.json
        .map(mapRecord)
        .filter((record): record is SessionRegistryRecord => record !== undefined);
    },
  };
}

export type ReconcileGateway = Pick<
  OpenShellClient["raw"],
  "getSandbox" | "deleteSandbox" | "deleteProvider" | "deleteProviderProfile" | "deleteWorkspace" | "getWorkspace"
>;

const rpcTimeoutMs = 10_000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = (error: unknown): boolean => error instanceof ConnectError && error.code === Code.NotFound;
// Phases that mean the sandbox is still in flight; anything else (COMPLETED,
// ERROR, STOPPED, UNKNOWN, UNSPECIFIED) is terminal for adoption purposes.
const runningPhases = new Set<SandboxPhase>([
  SandboxPhase.PROVISIONING,
  SandboxPhase.STARTING,
  SandboxPhase.READY,
  SandboxPhase.STOPPING,
  SandboxPhase.DELETING,
]);

/** Reconcile the open session-registry records of dead dispatcher pods.
 *
 * Runs once at startup, before new work is dispatched. Records owned by this
 * pod are skipped (its own in-flight sessions). For every other record the
 * gateway state decides: adopt a still-running sandbox until it terminates,
 * then clean up; clean up terminal or already-vanished sandboxes; release the
 * dead pod's session lock once the session is definitively finished. Every
 * step is best effort and individually isolated: a record whose
 * reconciliation fails is logged and left open so the next restart retries
 * it. The signal is honored between records and between adoption polls. */
export async function reconcileOpenSessions(options: {
  registry: SessionRegistryClient;
  lockClient: { release(key: string, token: string): Promise<boolean> };
  gateway: ReconcileGateway;
  /** Current pod hostname; records we own are our own in-flight sessions. */
  holder: string;
  signal?: AbortSignal;
  log: (event: string, status: "success" | "failure", data?: Record<string, unknown>) => void;
  /** Adoption poll spacing; default 30 seconds. */
  pollIntervalMs?: number;
  /** How long a adopted sandbox may keep running; default one hour. */
  adoptTimeoutMs?: number;
}): Promise<void> {
  const pollIntervalMs = options.pollIntervalMs ?? 30_000;
  const adoptTimeoutMs = options.adoptTimeoutMs ?? 60 * 60_000;
  const signal = options.signal;
  const callOptions = () => ({
    timeoutMs: rpcTimeoutMs,
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(rpcTimeoutMs)]) : AbortSignal.timeout(rpcTimeoutMs),
  });
  // Log details carry IDs only; a malformed run ID drops the field, not the
  // whole event (the lifecycle logger re-validates and drops malformed lines).
  const details = (record: SessionRegistryRecord, extra: Record<string, unknown>): Record<string, unknown> => ({
    ...(uuid.test(record.runId) ? { runId: record.runId } : {}),
    ...extra,
  });
  const releaseLock = async (record: SessionRegistryRecord): Promise<void> => {
    if (!record.lockToken || !record.agentId) return;
    const released = await options.lockClient.release(`agent-session:${record.agentId}`, record.lockToken);
    if (!released) options.log("sandbox.reconcile", "failure", details(record, { release: true }));
  };
  const finish = async (
    record: SessionRegistryRecord,
    outcome: { state: string; reason: string; adopted: boolean; releaseLock: boolean },
  ): Promise<void> => {
    const updated = await options.registry.update(record.runId, {
      state: outcome.state,
      detail: { reason: outcome.reason },
    });
    options.log("sandbox.reconcile", updated ? "success" : "failure", details(record, {
      reason: outcome.reason,
      adopted: outcome.adopted,
    }));
    if (outcome.releaseLock) await releaseLock(record);
  };
  // Best-effort deletion: an already-missing resource (NotFound) counts as
  // done; any other failure propagates and leaves the record open.
  const tolerantDelete = async (remove: () => Promise<unknown>): Promise<void> => {
    try {
      await remove();
    } catch (error) {
      if (!notFound(error)) throw error;
    }
  };
  const cleanup = async (record: SessionRegistryRecord, sandboxPresent: boolean): Promise<void> => {
    const { workspaceName, sandboxName, providerName, profileName } = record;
    if (!workspaceName) return;
    const scope = { selection: { case: "workspace" as const, value: workspaceName } };
    if (sandboxPresent && sandboxName) {
      await tolerantDelete(() =>
        options.gateway.deleteSandbox({ workspaceScope: scope, name: sandboxName, requestId: randomUUID() }, callOptions())
      );
    }
    // Dependency order mirrors SandboxSession cleanup: the provider references
    // the profile, so it is deleted first.
    if (providerName) {
      await tolerantDelete(() =>
        options.gateway.deleteProvider({ workspaceScope: scope, name: providerName, allowMissing: true, requestId: randomUUID() }, callOptions())
      );
    }
    if (profileName) {
      await tolerantDelete(() =>
        options.gateway.deleteProviderProfile({ workspaceScope: scope, id: profileName, allowMissing: true, requestId: randomUUID() }, callOptions())
      );
    }
    await tolerantDelete(() =>
      options.gateway.deleteWorkspace({ name: workspaceName, allowMissing: true, requestId: randomUUID() }, callOptions())
    );
  };
  // Never delete a resource unless its run-specific identity was verified.
  const owned = (labels: Record<string, string> | undefined, runId: string): boolean =>
    !!labels && labels["rehor-session"] === "agent" && labels["rehor-run-id"] === runId;

  const adopt = async (record: SessionRegistryRecord, workspaceName: string, sandboxName: string): Promise<void> => {
    const scope = { selection: { case: "workspace" as const, value: workspaceName } };
    const deadline = Date.now() + adoptTimeoutMs;
    let terminal = false;
    let vanished = false;
    for (;;) {
      if (signal?.aborted) return;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      try {
        await sleep(Math.min(pollIntervalMs, remaining), undefined, signal ? { signal } : undefined);
      } catch {
        return; // Aborted between polls.
      }
      if (signal?.aborted) return;
      let sandbox: { metadata?: { name?: string; labels?: Record<string, string> }; status?: { phase?: SandboxPhase } } | undefined;
      try {
        sandbox = (await options.gateway.getSandbox({ workspaceScope: scope, name: sandboxName }, callOptions())).sandbox;
      } catch (error) {
        if (notFound(error)) {
          vanished = true;
          break;
        }
        throw error;
      }
      const phase = sandbox?.status?.phase;
      if (!sandbox || !owned(sandbox.metadata?.labels, record.runId) || sandbox.metadata?.name !== sandboxName || phase === undefined) {
        throw new Error();
      }
      if (!runningPhases.has(phase)) {
        terminal = true;
        break;
      }
    }
    if (signal?.aborted) return;
    if (!terminal && !vanished) {
      // Adoption timed out: the sandbox may still run, so delete nothing and
      // keep the lock held (TTL expiry covers it) rather than risk starting a
      // second concurrent session for the agent.
      await finish(record, { state: "abandoned", reason: "adopt-timeout", adopted: true, releaseLock: false });
      return;
    }
    await cleanup(record, !vanished);
    await finish(record, { state: "completed", reason: "adopted", adopted: true, releaseLock: true });
  };

  const reconcileRecord = async (record: SessionRegistryRecord): Promise<void> => {
    // Our own in-flight sessions: the launch path owns their lifecycle.
    if (record.holder === options.holder) return;
    const { workspaceName, sandboxName, runId } = record;
    if (!workspaceName || !sandboxName) {
      // Died before sandbox provisioning: nothing gateway-visible was created
      // beyond (at most) a transient workspace; that leak window is seconds
      // and accepted. The dead pod's lock is released so the agent is not
      // blocked for a full TTL.
      await finish(record, { state: "abandoned", reason: "never-provisioned", adopted: false, releaseLock: true });
      return;
    }
    let workspace: { metadata?: { name?: string; labels?: Record<string, string> } } | undefined;
    let workspaceGone = false;
    try {
      workspace = (await options.gateway.getWorkspace({ name: workspaceName }, callOptions())).workspace;
    } catch (error) {
      if (!notFound(error)) throw error;
      workspaceGone = true;
    }
    if (workspaceGone) {
      // Nothing of the session exists; there is nothing to clean up.
      await finish(record, { state: "abandoned", reason: "workspace-gone", adopted: false, releaseLock: true });
      return;
    }
    if (!workspace?.metadata || workspace.metadata.name !== workspaceName || !owned(workspace.metadata.labels, runId)) {
      throw new Error();
    }
    let sandbox: { metadata?: { name?: string; labels?: Record<string, string> }; status?: { phase?: SandboxPhase } } | undefined;
    let sandboxGone = false;
    const scope = { selection: { case: "workspace" as const, value: workspaceName } };
    try {
      sandbox = (await options.gateway.getSandbox({ workspaceScope: scope, name: sandboxName }, callOptions())).sandbox;
    } catch (error) {
      if (!notFound(error)) throw error;
      sandboxGone = true;
    }
    if (sandboxGone) {
      // Leftover provider/profile/workspace may remain; the sandbox itself is
      // already gone, so only the dependencies are cleaned up.
      await cleanup(record, false);
      await finish(record, { state: "abandoned", reason: "sandbox-gone", adopted: false, releaseLock: true });
      return;
    }
    const phase = sandbox?.status?.phase;
    if (!sandbox?.metadata || sandbox.metadata.name !== sandboxName || !owned(sandbox.metadata.labels, runId) || phase === undefined) {
      throw new Error();
    }
    if (runningPhases.has(phase)) {
      await adopt(record, workspaceName, sandboxName);
      return;
    }
    await cleanup(record, true);
    await finish(record, { state: "completed", reason: "reconciled-terminal", adopted: false, releaseLock: true });
  };

  let records: SessionRegistryRecord[] = [];
  try {
    records = await options.registry.listOpen();
  } catch {
    records = [];
  }
  for (const record of records) {
    if (signal?.aborted) return;
    try {
      await reconcileRecord(record);
    } catch {
      // One failed record must not abort the rest; it stays open and the
      // next restart retries it.
      options.log("sandbox.reconcile", "failure", details(record, { reason: "record-failure" }));
    }
  }
}
