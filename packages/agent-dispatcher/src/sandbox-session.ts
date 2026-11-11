import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { OpenShellClient } from "@nvidia/openshell-sdk";
import { DeletionOutcome, NetworkPolicyRuleSchema, ProviderProfileCategory, ProviderReadinessState, SandboxPhase, SandboxPolicySchema, SandboxRestartPolicy } from "@nvidia/openshell-sdk/raw";
import { create, equals } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import type { WorkPreflightResult } from "./work-preflight.js";
import { buildInputEnvelope, INPUT_ENVIRONMENT, INPUT_FILE_PATH, MAX_INPUT_BYTES } from "./input-envelope.js";
import { createMemoryPolicy } from "./memory-policy.js";
import { withPublicEgress } from "./egress-policy.js";
import { isNormalizedAbsolutePath, pathsOverlap, type RuntimeLayout } from "./runtime-layout.js";

type Raw = Pick<OpenShellClient["raw"], "createWorkspace" | "getWorkspace" | "deleteWorkspace" | "listWorkspaceMembers" | "createSandbox" | "getSandbox" | "listSandboxes" | "deleteSandbox" | "execSandbox" | "importProviderProfiles" | "getProviderProfile" | "deleteProviderProfile" | "listProviderProfiles" | "getProvider" | "createProvider" | "deleteProvider" | "listProviders" | "getSandboxProviderStatus" | "getSandboxConfig">;
export type SandboxMemory = { url: URL; credentialProvider: { mint(): Promise<{ token: string; expiresAt: number }> } };
export type SandboxSessionOptions = {
  raw: Raw;
  memory: SandboxMemory;
  cleanupBudgetMs?: number;
  runtime?: RuntimeLayout;
  modelProxyUrl?: URL;
  /** Central public-egress rollout flag (REHOR-253); default false. */
  publicEgress?: boolean;
};
type ResourceState = "not-attempted" | "unknown" | "created" | "deleted";
type SessionStage = "input" | "policy" | "workspace" | "provider" | "sandbox" | "readiness" | "write" | "runner" | "complete";

export type SandboxSessionResult = {
  completion: "gone" | "not-created" | "unknown";
  outcome: "passed" | "failed" | "unknown";
  cleanup: "not-needed" | "deleted" | "unknown";
  stage: SessionStage;
  runId: string;
  runnerRequestId: string;
  writeRequestId: string;
  inputStatus?: "built" | "skipped" | "invalid" | "oversized";
  errorCode?: "invalid_argument" | "not_found" | "permission_denied" | "unauthenticated" | "deadline_exceeded" | "unavailable" | "cancelled" | "readiness_timeout" | "other";
  workspace: { name: string; requestId: string; state: ResourceState; id?: string };
  sandbox: { name: string; requestId: string; state: ResourceState; id?: string };
  profile: { name: string; state: ResourceState; version?: string };
  provider: { name: string; state: ResourceState; id?: string };
};

const rpcTimeoutMs = 10_000;
const defaultCleanupBudgetMs = 20 * 60_000;
const callOptions = (signal?: AbortSignal, timeoutMs = rpcTimeoutMs) => ({ timeoutMs, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
const isTransient = (error: unknown) => error instanceof ConnectError && (error.code === Code.Unavailable || error.code === Code.DeadlineExceeded);

async function retryTransient<T>(operation: () => Promise<T>, options: { attempts?: number; signal?: AbortSignal } = {}): Promise<T> {
  const attempts = options.attempts ?? 5;
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt + 1 >= attempts || !isTransient(error) || options.signal?.aborted) throw error;
      await sleep(Math.min(500 * 2 ** attempt, 4000), undefined, options.signal ? { signal: options.signal } : undefined);
    }
  }
}

async function retryDelete<T, R>(remove: () => Promise<T>, read: () => Promise<R | undefined>, matches: (resource: R) => boolean, signal: AbortSignal, attempts = 2): Promise<T | undefined> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await remove();
    } catch (error) {
      if (!isTransient(error)) throw error;
      const current = await readOptional(read, signal);
      if (!current) return undefined;
      if (!matches(current)) throw new Error();
      if (attempt + 1 >= attempts) throw error;
      await sleep(Math.min(500 * 2 ** attempt, 4000), undefined, { signal });
    }
  }
}

const idleCommand = ["/usr/bin/python3.12", "-c", "import threading; threading.Event().wait()"];
// Delivery exec: stdin → fixed path, created with mode 0600 (REHOR-226 contract).
const writeCommand = ["/usr/bin/python3.12", "-c", `import os,stat,sys
try:
    data = sys.stdin.buffer.read(${MAX_INPUT_BYTES + 1})
    if not data or len(data) > ${MAX_INPUT_BYTES}: sys.exit(1)
    fd = os.open(${JSON.stringify(INPUT_FILE_PATH)}, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w+b") as stream:
        os.fchmod(stream.fileno(), 0o600)
        stream.write(data)
        stream.flush()
        stream.seek(0)
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600 or stream.read() != data: sys.exit(1)
except Exception:
    sys.exit(1)`];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function snapshot(value: SandboxSessionResult): SandboxSessionResult {
  return { ...value, workspace: { ...value.workspace }, sandbox: { ...value.sandbox }, profile: { ...value.profile }, provider: { ...value.provider } };
}

function errorCode(error: unknown, signal?: AbortSignal): NonNullable<SandboxSessionResult["errorCode"]> {
  if (signal?.aborted) return "cancelled";
  if (!(error instanceof ConnectError)) return "other";
  const codes: Record<number, NonNullable<SandboxSessionResult["errorCode"]>> = {
    [Code.InvalidArgument]: "invalid_argument", [Code.NotFound]: "not_found", [Code.PermissionDenied]: "permission_denied",
    [Code.Unauthenticated]: "unauthenticated", [Code.DeadlineExceeded]: "deadline_exceeded", [Code.Unavailable]: "unavailable", [Code.Canceled]: "cancelled",
  };
  return codes[error.code] ?? "other";
}

/** Absence requires explicit NotFound; empty/malformed responses are ambiguous. */
async function readOptional<T>(read: () => Promise<T | undefined>, signal?: AbortSignal): Promise<T | undefined> {
  try {
    const value = await retryTransient(read, { signal });
    if (!value) throw new Error();
    return value;
  } catch (error) {
    if (error instanceof ConnectError && error.code === Code.NotFound) return undefined;
    throw error;
  }
}

async function waitAbsent<T>(read: () => Promise<T | undefined>, matches: (value: T) => boolean, signal: AbortSignal): Promise<void> {
  const deadline = performance.now() + 300_000;
  while (performance.now() < deadline && !signal.aborted) {
    const value = await readOptional(read, signal);
    if (!value) return;
    if (!matches(value)) throw new Error();
    await sleep(2000, undefined, { signal });
  }
  throw new ConnectError("", Code.DeadlineExceeded);
}

/** Run one admitted session. Admission belongs to SessionDispatcher, not here.
 * No input or remote error text is logged. Cleanup ambiguity retains admission.
 * Runner is invoked under constrained bootstrap policy, not a claim of complete
 * runtime compatibility: service policy mapping remains REHOR-215; input
 * consumption and filesystem/runtime validation remain REHOR-233. */
export class SandboxSession {
  private readonly raw: Raw;
  private readonly memory: SandboxMemory;
  private readonly cleanupBudgetMs: number;
  private readonly runtime: RuntimeLayout;
  private readonly modelProxyUrl: URL | undefined;
  private readonly publicEgress: boolean;

  constructor({
    raw,
    memory,
    cleanupBudgetMs = defaultCleanupBudgetMs,
    runtime = { kind: "legacy" },
    modelProxyUrl,
    publicEgress = false,
  }: SandboxSessionOptions) {
    this.raw = raw;
    this.memory = memory;
    this.cleanupBudgetMs = cleanupBudgetMs;
    this.runtime = runtime;
    this.modelProxyUrl = modelProxyUrl;
    this.publicEgress = publicEgress;
  }

  /** image comes from the canonical profile image validator; never shell-expanded. */
  async run(image: string, decision: Extract<WorkPreflightResult, { action: "start" }>, environment: Record<string, string>, signal?: AbortSignal): Promise<SandboxSessionResult> {
    const runId = randomUUID();
    const built = buildInputEnvelope(decision, runId);
    // Gateway resource names allow at most 19 characters, including prefix.
    const suffix = (BigInt(`0x${runId.replaceAll("-", "")}`) % (36n ** 18n)).toString(36).padStart(18, "0");
    const record: SandboxSessionResult = {
      completion: "not-created", outcome: "unknown", cleanup: "not-needed", stage: "input", runId,
      runnerRequestId: randomUUID(), writeRequestId: randomUUID(), inputStatus: built.status,
      workspace: { name: `w${suffix}`, requestId: randomUUID(), state: "not-attempted" },
      sandbox: { name: `s${suffix}`, requestId: randomUUID(), state: "not-attempted" },
      profile: { name: `p${suffix}`, state: "not-attempted" }, provider: { name: `v${suffix}`, state: "not-attempted" },
    };
    if (built.status !== "built") {
      if (built.status !== "skipped") record.errorCode = "invalid_argument";
      return record;
    }
    if (signal?.aborted) { record.errorCode = "cancelled"; return record; }
    return this.execute(record, image, built.serialized, environment, signal);
  }

  private async execute(record: SandboxSessionResult, image: string, content: Buffer, environment: Record<string, string>, signal?: AbortSignal): Promise<SandboxSessionResult> {
    const { workspace, sandbox, runId } = record;
    const scope = { selection: { case: "workspace" as const, value: workspace.name } };
    const labels = { "rehor-session": "agent", "rehor-run-id": runId };
    const workspaceMatches = (meta: { id: string; name: string; labels: Record<string, string> } | undefined) =>
      !!meta && uuid.test(meta.id) && meta.name === workspace.name && meta.labels?.["rehor-session"] === labels["rehor-session"] && meta.labels?.["rehor-run-id"] === runId;
    const sandboxMatches = (meta: { id: string; name: string; workspace: string; labels: Record<string, string> } | undefined) =>
      !!meta && uuid.test(meta.id) && meta.name === sandbox.name && meta.workspace === workspace.name && meta.labels?.["rehor-session"] === labels["rehor-session"] && meta.labels?.["rehor-run-id"] === runId;
    try {
      signal?.throwIfAborted();
      record.stage = "policy";
      // The centrally compiled public-egress rule merges here, at sandbox
      // policy construction, and only under the deployment-owned flag; it is
      // never sourced from profiles, preflightEnv, or any per-agent input.
      const policy = withPublicEgress(
        createMemoryPolicy(this.memory.url, record.provider.name, this.runtime, this.modelProxyUrl),
        this.publicEgress,
      );
      record.stage = "workspace";
      workspace.state = "unknown";
      const createdWorkspace = (await this.raw.createWorkspace({ name: workspace.name, labels, requestId: workspace.requestId }, callOptions(signal))).workspace;
      if (!workspaceMatches(createdWorkspace?.metadata)) throw new Error();
      workspace.id = createdWorkspace!.metadata!.id;
      workspace.state = "created";
      const currentWorkspace = (await this.raw.getWorkspace({ name: workspace.name }, callOptions(signal))).workspace;
      if (!workspaceMatches(currentWorkspace?.metadata) || currentWorkspace?.metadata?.id !== workspace.id) throw new Error();
      const members = await this.raw.listWorkspaceMembers({ workspaceScope: scope, pageSize: 1 }, callOptions(signal));
      if (members.members.length || members.nextPageToken) throw new Error();

      let providerVersion = 0n;
      {
        record.stage = "provider";
        record.profile.state = "unknown";
        const imported = await this.raw.importProviderProfiles({ workspaceScope: scope, requestId: randomUUID(), profiles: [{ profile: {
          id: record.profile.name, displayName: record.profile.name, category: ProviderProfileCategory.OTHER,
          credentials: [{ name: "BOT_MEMORY_TOKEN", envVars: ["BOT_MEMORY_TOKEN"], required: true, authStyle: "bearer", headerName: "Authorization" }],
        } }] }, callOptions(signal));
        if (!imported.imported || imported.profiles.length !== 1 || imported.profiles[0].id !== record.profile.name || imported.profiles[0].resourceVersion <= 0n || imported.diagnostics.some((d) => d.severity.toLowerCase() === "error")) throw new Error();
        const profileVersion = imported.profiles[0].resourceVersion;
        record.profile.version = profileVersion.toString();
        const profile = (await this.raw.getProviderProfile({ workspaceScope: scope, id: record.profile.name }, callOptions(signal))).profile;
        const field = profile?.credentials?.[0];
        if (!profile || profile.id !== record.profile.name || profile.scope !== "workspace" || profile.source !== "user" || profile.resourceVersion !== profileVersion || profile.category !== ProviderProfileCategory.OTHER || profile.inferenceCapable || profile.endpoints.length || profile.binaries.length || profile.files.length || profile.discovery || profile.credentials.length !== 1 || !field || field.name !== "BOT_MEMORY_TOKEN" || field.envVars.length !== 1 || field.envVars[0] !== "BOT_MEMORY_TOKEN" || !field.required || field.authStyle !== "bearer" || field.headerName.toLowerCase() !== "authorization" || field.refresh || field.tokenGrant || field.tokenGrantOwners.length || field.queryParam || field.pathTemplate || field.stablePlaceholder) throw new Error();
        record.profile.state = "created";
        signal?.throwIfAborted();
        const credential = await this.memory.credentialProvider.mint();
        if (!credential.token || !Number.isSafeInteger(credential.expiresAt) || credential.expiresAt <= Date.now() + 180_000) throw new Error();
        signal?.throwIfAborted();
        record.provider.state = "unknown";
        const created = (await this.raw.createProvider({ workspaceScope: scope, requestId: randomUUID(), provider: {
          metadata: { name: record.provider.name }, type: record.profile.name, profileWorkspace: workspace.name,
          credentials: { BOT_MEMORY_TOKEN: credential.token },
          credentialExpirationTimes: { BOT_MEMORY_TOKEN: { seconds: BigInt(Math.floor(credential.expiresAt / 1000)), nanos: (credential.expiresAt % 1000) * 1_000_000 } },
        } }, callOptions(signal))).provider;
        if (!created?.metadata?.id || !uuid.test(created.metadata.id) || created.metadata.name !== record.provider.name || created.metadata.workspace !== workspace.name || created.metadata.resourceVersion <= 0n || created.type !== record.profile.name || created.profileWorkspace !== workspace.name) throw new Error();
        record.provider.id = created.metadata.id;
        providerVersion = created.metadata.resourceVersion;
        record.provider.state = "created";
      }

      record.stage = "sandbox";
      signal?.throwIfAborted();
      sandbox.state = "unknown";
      const createdSandbox = (await this.raw.createSandbox({ workspaceScope: scope, name: sandbox.name, labels, requestId: sandbox.requestId, spec: {
        template: { image }, environment: {}, providers: [record.provider.name], policy,
        command: [...idleCommand], restartPolicy: SandboxRestartPolicy.NEVER,
      } }, callOptions(signal))).sandbox;
      if (!sandboxMatches(createdSandbox?.metadata)) throw new Error();
      sandbox.id = createdSandbox!.metadata!.id;
      sandbox.state = "created";

      record.stage = "readiness";
      let ready = false;
      // Status polling only; never retry a create or execute request.
      const readinessDeadline = performance.now() + 10 * 60_000;
      while (performance.now() < readinessDeadline) {
        let current;
        try {
          current = (await this.raw.getSandbox({ workspaceScope: scope, name: sandbox.name }, callOptions(signal))).sandbox;
        } catch (error) {
          if (isTransient(error) && !signal?.aborted) {
            await sleep(1000, undefined, { signal });
            continue;
          }
          throw error;
        }
        if (!sandboxMatches(current?.metadata) || current?.metadata?.id !== sandbox.id || !current.status) throw new Error();
        if (current.status.phase === SandboxPhase.READY) { ready = true; break; }
        if (current.status.phase !== SandboxPhase.PROVISIONING && current.status.phase !== SandboxPhase.STARTING) throw new Error();
        await sleep(Math.min(1000, Math.max(1, readinessDeadline - performance.now())), undefined, { signal });
      }
      if (!ready) {
        record.errorCode = "readiness_timeout";
        throw new Error();
      }
      const checkedWorkspace = (await this.raw.getWorkspace({ name: workspace.name }, callOptions(signal))).workspace;
      if (!workspaceMatches(checkedWorkspace?.metadata) || checkedWorkspace?.metadata?.id !== workspace.id) throw new Error();
      {
        let providerReady = false;
        while (performance.now() < readinessDeadline) {
          const config = await retryTransient(
            () => this.raw.getSandboxConfig({ workspaceScope: scope, name: sandbox.name }, callOptions(signal)), { signal },
          );
          const status = (await retryTransient(
            () => this.raw.getSandboxProviderStatus({ workspaceScope: scope, sandbox: sandbox.name, provider: record.provider.name }, callOptions(signal)), { signal },
          )).status;
          const desired = status?.receipt?.desired, observed = status?.observed;
          if (config.configurationAdmitted && status?.state === ProviderReadinessState.READY && desired?.sandboxId === sandbox.id && desired.providerId === record.provider.id && desired.providerResourceVersion === providerVersion && desired.attachmentEpoch === config.providerAttachmentEpoch && desired.configRevision === config.configRevision && desired.policyHash === config.policyHash && desired.providerEnvRevision === config.providerEnvRevision && observed?.attachmentEpoch === config.providerAttachmentEpoch && observed.configRevision === config.configRevision && observed.policyHash === config.policyHash && observed.providerEnvRevision === config.providerEnvRevision && observed.credentialsInstalled && observed.policyActive && observed.launchEnvironmentInstalled) {
            const expected = create(SandboxPolicySchema, policy);
            let credentialBound = false;
            for (const rule of Object.values(expected.networkPolicies)) {
              for (const endpoint of rule.endpoints) {
                if (endpoint.credentialBinding?.provider === record.provider.name) {
                  endpoint.providerCredentialed = true;
                  credentialBound = true;
                }
              }
            }
            // Gateway may enrich effective policy with baseline/defaults.
            // Preserve exact supplied credential rules, not whole-policy equality.
            if (!credentialBound || !config.policy) throw new Error();
            if (this.publicEgress) {
              // Central public egress (REHOR-253): while enabled, the
              // effective network rule key set must match the requested
              // set exactly. Legacy flag-off behavior keeps accepting
              // additive Gateway baselines.
              const expectedKeys = Object.keys(expected.networkPolicies).sort();
              const actualKeys = Object.keys(config.policy.networkPolicies ?? {}).sort();
              if (expectedKeys.length !== actualKeys.length || expectedKeys.some((key, index) => key !== actualKeys[index])) throw new Error();
            }
            for (const [name, rule] of Object.entries(expected.networkPolicies)) {
              const actual = config.policy.networkPolicies[name];
              if (!actual || !equals(NetworkPolicyRuleSchema, rule, actual)) throw new Error();
            }
            const filesystem = config.policy.filesystem;
            if (!filesystem
              || expected.filesystem?.readOnly.some((path) => !filesystem.readOnly.includes(path))
              || expected.filesystem?.readWrite.some((path) => !filesystem.readWrite.includes(path))
              || (filesystem.includeWorkdir && !expected.filesystem?.includeWorkdir)
              // Landlock grants are additive: a read-only rule cannot revoke
              // an overlapping write grant. Permit only exact, disjoint additions.
              || filesystem.readWrite.some((path) => !isNormalizedAbsolutePath(path)
                || expected.filesystem?.readOnly.some((readOnly) => pathsOverlap(path, readOnly)))) throw new Error();
            providerReady = true;
            break;
          }
          await sleep(1000, undefined, { signal });
        }
        if (!providerReady) throw new Error();
      }

      record.stage = "write";
      signal?.throwIfAborted();
      const execute = async (command: string[], input: Buffer, requestId: string, runner = false) => {
        let exit: number | undefined;
        const stream = this.raw.execSandbox({ workspaceScope: scope, sandbox: sandbox.name, command, stdin: input,
          environment: runner ? { ...environment, ...INPUT_ENVIRONMENT, ...(this.runtime.kind === "private" ? { REHOR_RUNTIME_SOURCE: this.runtime.source, REHOR_RUNTIME_PARENT: this.runtime.parent } : {}) } : {},
          workdir: this.runtime.kind === "private" ? this.runtime.parent : "/home/botuser/app", noLoginShell: true,
          ...(runner ? {} : { executionTimeout: { seconds: 30n } }), requestId,
        }, runner ? { signal } : callOptions(signal));
        for await (const event of stream) {
          if (exit !== undefined) throw new Error();
          if (event.payload.case === "exit") {
            const code = event.payload.value.exitCode;
            if (!Number.isInteger(code) || code < 0 || code > 255) throw new Error();
            exit = code;
          } else if (event.payload.case === "stdout" || event.payload.case === "stderr") {
            // Drain without copying, retaining, decoding or logging output.
          } else throw new Error();
        }
        if (exit === undefined) throw new Error();
        return exit;
      };
      const written = await execute([...writeCommand], content, record.writeRequestId);
      if (written !== 0) record.outcome = "failed";
      else {
        record.stage = "runner";
        signal?.throwIfAborted();
        const command = this.runtime.kind === "private"
          ? ["/usr/bin/python3.12", "/opt/rehor/sandbox-bootstrap.py"]
          : ["/usr/bin/bash", "/home/botuser/app/entrypoint.sh"];
        const exit = await execute(command, Buffer.alloc(0), record.runnerRequestId, true);
        record.outcome = exit === 0 ? "passed" : "failed";
      }
      record.stage = "complete";
    } catch (error) {
      // Includes RPC errors, malformed responses, timeouts and identity drift.
      // Do not retain or expose their potentially sensitive messages.
      record.outcome = "unknown";
      record.errorCode ??= errorCode(error, signal);
    }
    if (workspace.state === "not-attempted" && sandbox.state === "not-attempted") {
      record.cleanup = "not-needed";
    } else {
      record.completion = "unknown";
      record.cleanup = "unknown";
      // Bound the entire reconciliation once, not the sum of per-RPC retries.
      const cleanupSignal = AbortSignal.timeout(this.cleanupBudgetMs);
      try {
        // Recover ambiguous create responses by looking up deterministic names
        // and checking run-specific ownership metadata before deleting anything.
        const cleanupOptions = (timeoutMs = rpcTimeoutMs) => callOptions(cleanupSignal, timeoutMs);
        const readWorkspace = async () => (await this.raw.getWorkspace({ name: workspace.name }, cleanupOptions())).workspace;
        const readSandbox = async () => (await this.raw.getSandbox({ workspaceScope: scope, name: sandbox.name }, cleanupOptions())).sandbox;
        const currentWorkspace = await readOptional(readWorkspace, cleanupSignal);
        if (!currentWorkspace) {
          // A NotFound immediately after an uncertain create does not prove
          // the server-side operation stopped; it may still commit later.
          if (workspace.state === "unknown") throw new Error();
          if (sandbox.state !== "not-attempted" || record.profile.state !== "not-attempted" || record.provider.state !== "not-attempted") throw new Error();
          workspace.state = "deleted";
          sandbox.state = "deleted";
          record.profile.state = "deleted";
          record.provider.state = "deleted";
          record.cleanup = "deleted";
          record.completion = "gone";
          return snapshot(record);
        }
        if (!workspaceMatches(currentWorkspace.metadata) || (workspace.id && currentWorkspace.metadata?.id !== workspace.id)) throw new Error();
        workspace.id = currentWorkspace.metadata!.id;
        workspace.state = "created";

        const currentSandbox = await readOptional(readSandbox, cleanupSignal);
        if (currentSandbox) {
          if (!sandboxMatches(currentSandbox.metadata) || (sandbox.id && currentSandbox.metadata?.id !== sandbox.id)) throw new Error();
          sandbox.id = currentSandbox.metadata!.id;
          sandbox.state = "created";
          const request = { workspaceScope: scope, name: sandbox.name, requestId: randomUUID() };
          const deleted = await retryDelete(
            () => this.raw.deleteSandbox(request, cleanupOptions(180_000)),
            readSandbox,
            (current) => sandboxMatches(current.metadata) && current.metadata?.id === sandbox.id,
            cleanupSignal,
          );
          if (deleted && (deleted.sandboxId !== sandbox.id || (deleted.outcome !== DeletionOutcome.ACCEPTED && deleted.outcome !== DeletionOutcome.COMPLETED))) throw new Error();
          await waitAbsent(readSandbox, (current) => sandboxMatches(current.metadata) && current.metadata?.id === sandbox.id, cleanupSignal);
        } else if (sandbox.state === "unknown") {
          // Do not release dependencies while an ambiguous sandbox create may
          // still become visible after this read.
          throw new Error();
        }
        sandbox.state = "deleted";

        const members = await retryTransient(() => this.raw.listWorkspaceMembers({ workspaceScope: scope, pageSize: 100 }, cleanupOptions()), { signal: cleanupSignal });
        if (members.members.length || members.nextPageToken) throw new Error();
        const remainingSandboxes = await retryTransient(() => this.raw.listSandboxes({ workspaceScope: scope, pageSize: 100 }, cleanupOptions()), { signal: cleanupSignal });
        if (remainingSandboxes.sandboxes.length || remainingSandboxes.nextPageToken) throw new Error();

        if (record.provider.state === "created" || record.provider.state === "unknown") {
          const readProvider = async () => (await this.raw.getProvider({ workspaceScope: scope, name: record.provider.name }, cleanupOptions())).provider;
          const current = await readOptional(readProvider, cleanupSignal);
          if (!current && record.provider.state === "unknown") throw new Error();
          if (current) {
            if (current.metadata?.name !== record.provider.name || current.metadata.workspace !== workspace.name
              || current.type !== record.profile.name || current.profileWorkspace !== workspace.name
              || !uuid.test(current.metadata.id)
              || (record.provider.id && current.metadata.id !== record.provider.id)) throw new Error();
            record.provider.id = current.metadata.id;
            record.provider.state = "created";
            const request = { workspaceScope: scope, name: record.provider.name, allowMissing: false, requestId: randomUUID() };
            await retryDelete(
              () => this.raw.deleteProvider(request, cleanupOptions()),
              readProvider,
              (resource) => resource.metadata?.name === record.provider.name && resource.metadata.workspace === workspace.name
                && resource.type === record.profile.name && resource.profileWorkspace === workspace.name
                && uuid.test(resource.metadata.id) && resource.metadata.id === record.provider.id,
              cleanupSignal,
            );
          }
          if (await readOptional(readProvider, cleanupSignal)) throw new Error();
          record.provider.state = "deleted";
        }

        if (record.profile.state === "created" || record.profile.state === "unknown") {
          const readProfile = async () => (await this.raw.getProviderProfile({ workspaceScope: scope, id: record.profile.name }, cleanupOptions())).profile;
          const current = await readOptional(readProfile, cleanupSignal);
          if (!current && record.profile.state === "unknown") throw new Error();
          if (current) {
            if (current.id !== record.profile.name || current.scope !== "workspace" || current.source !== "user"
              || (record.profile.version !== undefined && current.resourceVersion.toString() !== record.profile.version)
              || current.category !== ProviderProfileCategory.OTHER || current.endpoints.length || current.binaries.length || current.files.length) throw new Error();
            record.profile.state = "created";
            const request = { workspaceScope: scope, id: record.profile.name, allowMissing: false, requestId: randomUUID() };
            await retryDelete(
              () => this.raw.deleteProviderProfile(request, cleanupOptions()),
              readProfile,
              (resource) => resource.id === record.profile.name && resource.scope === "workspace" && resource.source === "user"
                && (record.profile.version === undefined || resource.resourceVersion.toString() === record.profile.version)
                && resource.category === ProviderProfileCategory.OTHER && !resource.endpoints.length && !resource.binaries.length && !resource.files.length,
              cleanupSignal,
            );
          }
          if (await readOptional(readProfile, cleanupSignal)) throw new Error();
          record.profile.state = "deleted";
        }

        const [providers, profiles] = await Promise.all([
          retryTransient(() => this.raw.listProviders({ workspaceScope: scope, pageSize: 100 }, cleanupOptions()), { signal: cleanupSignal }),
          retryTransient(() => this.raw.listProviderProfiles({ workspaceScope: scope, pageSize: 100 }, cleanupOptions()), { signal: cleanupSignal }),
        ]);
        if (providers.providers.length || providers.nextPageToken || profiles.profiles.length || profiles.nextPageToken) throw new Error();

        const finalWorkspace = (await retryTransient(() => this.raw.getWorkspace({ name: workspace.name }, cleanupOptions()), { signal: cleanupSignal })).workspace;
        if (!workspaceMatches(finalWorkspace?.metadata) || finalWorkspace?.metadata?.id !== workspace.id) throw new Error();
        const request = { name: workspace.name, allowMissing: false, requestId: randomUUID() };
        await retryDelete(
          () => this.raw.deleteWorkspace(request, cleanupOptions(180_000)),
          readWorkspace,
          (resource) => workspaceMatches(resource.metadata) && resource.metadata?.id === workspace.id,
          cleanupSignal,
        );
        await waitAbsent(readWorkspace, (remaining) => workspaceMatches(remaining.metadata) && remaining.metadata?.id === workspace.id, cleanupSignal);
        workspace.state = "deleted";
        record.cleanup = "deleted";
        record.completion = "gone";
      } catch (error) {
        // Never delete a resource unless its run-specific identity was verified.
        record.cleanup = "unknown";
        record.outcome = "unknown";
        record.errorCode ??= cleanupSignal.aborted ? "deadline_exceeded" : errorCode(error);
      }
    }
    return snapshot(record);
  }
}
