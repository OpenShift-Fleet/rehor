import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { create, equals } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { DeletionOutcome, NetworkPolicyRuleSchema, ProviderProfileCategory, ProviderReadinessState, SandboxPhase, SandboxPolicySchema, SandboxRestartPolicy } from "@nvidia/openshell-sdk/raw";
import { readAuthConfig } from "./config.js";
import { readGatewayConfig } from "./gateway-config.js";
import { connectGateway } from "./gateway.js";
import { createCredentialProvider } from "./preflight.js";
import { createMemorySandboxPolicy } from "./sandbox-policy.js";
import { probeResourceNames, writeProbeLog, type GatewayDeleteOutcome, type ProbeExecMarker, type ProbeExecMetrics, type ProbeLogCode, type StartupDiagnostic } from "./logging.js";

const node = "/usr/bin/node-22";
const timeoutMs = 10_000;
const maxExecEvents = 1024;
const maxExecBytes = 65_536;
type State = "none" | "unknown" | "known";
type Stage = "configuration" | "workspace" | "provider" | "sandbox" | "diagnostic" | "connectivity" | "cleanup";
type ExecPhase = "diagnostic" | "probe";
type ExecFailureCode = Extract<ProbeLogCode, `${"diagnostic" | "probe"}_${string}`>;
class SandboxExecError extends Error {
  constructor(readonly code: ExecFailureCode | ProbeLogCode, readonly metrics: ProbeExecMetrics, readonly diagnostic?: StartupDiagnostic) { super("Sandbox exec failed"); }
}
const probeOutputCodes: Record<string, ProbeLogCode> = {
  "probe: unexpected": "probe_unexpected",
  "probe: missing-token": "probe_missing_token",
  "probe: invalid-config": "probe_invalid_config",
  "probe: redirect": "probe_redirect",
  "probe: http-error": "probe_http_error",
  "probe: http-unauthorized": "probe_http_unauthorized",
  "probe: http-forbidden": "probe_http_forbidden",
  "probe: tls-error": "probe_tls_error",
  "probe: timeout": "probe_timeout",
  "probe: request-error": "probe_request_error",
  "probe: dns-error": "probe_dns_error",
  "probe: connection-error": "probe_connection_error",
};
const probeMarkerLines: Record<string, ProbeExecMarker> = {
  "probe: started": "probe-started",
  "probe: config-ok": "probe-config-ok",
  "probe: request-started": "probe-request-started",
  "probe: success": "probe-success",
};
function nodeStartupFailure(stderr: string): ProbeLogCode | undefined {
  if (/\bEACCES:/.test(stderr)) return "probe_node_eacces";
  if (/\bEPERM:/.test(stderr)) return "probe_node_eperm";
  if (/\bERR_MODULE_NOT_FOUND\b/.test(stderr)) return "probe_node_err_module_not_found";
  if (/\bMODULE_NOT_FOUND\b/.test(stderr)) return "probe_node_module_not_found";
  if (/\bERR_REQUIRE_ESM\b/.test(stderr)) return "probe_node_require_esm";
  if (/^SyntaxError:/m.test(stderr)) return "probe_node_syntax_error";
  if (/^node: (?:bad option:|--[^\s]+ is not allowed in NODE_OPTIONS)/m.test(stderr)) return "probe_node_option_error";
  if (/\b(?:ERR_UNKNOWN_BUILTIN_MODULE|ERR_PACKAGE_PATH_NOT_EXPORTED|ERR_PACKAGE_IMPORT_NOT_DEFINED|ERR_UNSUPPORTED_DIR_IMPORT|ERR_INVALID_PACKAGE_CONFIG|ERR_INVALID_MODULE_SPECIFIER)\b/.test(stderr)) return "probe_node_module_load_error";
  return undefined;
}
const startupDiagnosticCommand = String.raw`const fs = require("node:fs");
const token = process.env.REHOR_MEMORY_TOKEN;
const healthUrl = process.env.REHOR_MEMORY_HEALTH_URL;
let probeFileExists = false;
let probeFileReadable = false;
try {
  const info = fs.statSync("/opt/probe/probe.js");
  probeFileExists = info.isFile();
  if (probeFileExists) {
    const fd = fs.openSync("/opt/probe/probe.js", fs.constants.O_RDONLY);
    try { probeFileReadable = fs.readSync(fd, Buffer.alloc(1), 0, 1, 0) === 1; }
    finally { fs.closeSync(fd); }
  }
} catch {}
const result = {
  nodeRuns: true,
  probeFileExists,
  probeFileReadable,
  healthUrlShape: typeof healthUrl === "string" && /^https:\/\/[A-Za-z0-9.-]+(?::[0-9]+)?\/health$/.test(healthUrl),
  tokenPlaceholderShape: typeof token === "string" && /^openshell:resolve:env:(?:v[1-9][0-9]*_REHOR_MEMORY_TOKEN|s[0-9a-f]{64}_REHOR_MEMORY_TOKEN)$/.test(token),
};
fs.writeSync(1, JSON.stringify(result) + "\n");`;
function parseStartupDiagnostic(output: string): StartupDiagnostic | undefined {
  const lines = output.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  if (lines.length !== 1) return undefined;
  let value: unknown;
  try { value = JSON.parse(lines[0]); } catch { return undefined; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const keys = ["nodeRuns", "probeFileExists", "probeFileReadable", "healthUrlShape", "tokenPlaceholderShape"];
  if (Object.keys(record).length !== keys.length || Object.keys(record).some((key) => !keys.includes(key)) || keys.some((key) => typeof record[key] !== "boolean")) return undefined;
  return record as unknown as StartupDiagnostic;
}

function startupDiagnosticFailure(diagnostic: StartupDiagnostic): ProbeLogCode | undefined {
  if (!diagnostic.nodeRuns) return "diagnostic_node_not_running";
  if (!diagnostic.probeFileExists) return "diagnostic_probe_file_missing";
  if (!diagnostic.probeFileReadable) return "diagnostic_probe_file_unreadable";
  if (!diagnostic.healthUrlShape) return "diagnostic_health_url_invalid";
  if (!diagnostic.tokenPlaceholderShape) return "diagnostic_token_placeholder_invalid";
  return undefined;
}
const options = () => ({ timeoutMs, signal: AbortSignal.timeout(timeoutMs) });
const errorCode = (error: unknown) => {
  if (error instanceof SandboxExecError) return error.code;
  if (!(error instanceof ConnectError)) return "other" as const;
  switch (error.code) {
    case Code.InvalidArgument: return "invalid_argument" as const;
    case Code.PermissionDenied: return "permission_denied" as const;
    case Code.Unauthenticated: return "unauthenticated" as const;
    case Code.DeadlineExceeded: return "deadline_exceeded" as const;
    case Code.Canceled: return "cancelled" as const;
    case Code.Unavailable: return "unavailable" as const;
    default: return "other" as const;
  }
};

// Treat only explicit, pre-admission rejection codes as definitely not created.
// Timeouts, transport failures, malformed responses and all other codes remain ambiguous.
async function createResource<T>(setState: (state: State) => void, call: () => Promise<T>): Promise<T> {
  try { return await call(); }
  catch (error) {
    if (error instanceof ConnectError && [Code.InvalidArgument, Code.PermissionDenied, Code.Unauthenticated].includes(error.code)) setState("none");
    throw error;
  }
}

async function main(runId: string): Promise<void> {
  let stage: Stage = "configuration";
  let failed = false;
  let incomplete = false;
  let resource: "workspace" | "profile" | "provider" | "sandbox" | undefined;
  let cleanupResource: "workspace" | "profile" | "provider" | "sandbox" = "workspace";
  let workspaceState: State = "none", profileState: State = "none", providerState: State = "none", sandboxState: State = "none";
  let workspaceId = "", providerId = "", sandboxId = "", profileVersion = 0n, providerVersion = 0n;
  let sandboxDeleteOutcome: GatewayDeleteOutcome | undefined;
  let sandboxDeletePending = false;
  let acceptedSandboxDeletePending = false;
  const { workspace, profile, provider, sandbox } = probeResourceNames(runId);
  const log = (stage: Stage, status: "start" | "success" | "failure" | "incomplete", resource?: "workspace" | "profile" | "provider" | "sandbox", code?: ProbeLogCode, exitCode?: number, exec?: ProbeExecMetrics, diagnostic?: StartupDiagnostic, gatewayDeleteOutcome?: GatewayDeleteOutcome) => writeProbeLog(runId, stage, status, resource, code, exitCode, exec, diagnostic, gatewayDeleteOutcome);
  const scope = { selection: { case: "workspace" as const, value: workspace } };
  let client: Awaited<ReturnType<typeof connectGateway>> | undefined;
  let interrupted = false;
  const stop = () => { interrupted = true; };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  try {
    log(stage, "start");
    const auth = readAuthConfig(process.env);
    const gateway = readGatewayConfig(process.env);
    const image = process.env.REHOR_PROBE_IMAGE;
    // Explicit registry/repository and immutable digest only: no URL schemes,
    // userinfo, whitespace, queries, fragments, or unpinned tags.
    const reference = /^(?:[a-z0-9]+(?:[.-][a-z0-9]+)*)(?::([1-9][0-9]{0,4}))?\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?@sha256:[a-f0-9]{64}$/;
    const match = image && image.length <= 512 ? reference.exec(image) : null;
    if (!auth || !gateway || !gateway.subject || !match || (match[1] && Number(match[1]) > 65535) || process.env.REHOR_PROBE_TRUST_GATEWAY !== "acknowledged") throw new Error();
    const allowedIps = process.env.REHOR_PROBE_ALLOWED_IPS?.split(",");
    const policy = createMemorySandboxPolicy({ memoryUrl: auth.memoryUrl.toString(), nodeBinaryPath: node, providerName: provider, ...(allowedIps ? { allowedIps } : {}) });
    client = await connectGateway(gateway);
    const raw = client.raw;
    log(stage, "success");

    const executeSandbox = async (command: string[], phase: ExecPhase) => {
      const metrics: ProbeExecMetrics = { phase, eventCount: 0, stdoutBytes: 0, stderrBytes: 0, ...(phase === "probe" ? { markers: [] } : {}) };
      const output: Record<"stdout" | "stderr", Buffer[]> = { stdout: [], stderr: [] };
      let pendingStdoutLine = "";
      const recordMarkerLine = (line: string) => {
        const marker = Object.hasOwn(probeMarkerLines, line) ? probeMarkerLines[line] : undefined;
        if (!marker || phase !== "probe") return;
        const markers = metrics.markers ?? (metrics.markers = []);
        if (markers.length < 8) markers.push(marker);
        else metrics.markersTruncated = true;
      };
      const consumeStdout = (chunk: Buffer, final = false) => {
        pendingStdoutLine += chunk.toString("utf8");
        const lines = pendingStdoutLine.split(/\r?\n/);
        pendingStdoutLine = lines.pop() ?? "";
        for (const line of lines) recordMarkerLine(line);
        if (final && pendingStdoutLine.length) {
          recordMarkerLine(pendingStdoutLine.endsWith("\r") ? pendingStdoutLine.slice(0, -1) : pendingStdoutLine);
          pendingStdoutLine = "";
        }
      };
      const makeError = (suffix: string) => new SandboxExecError(`${phase}_${suffix}` as ExecFailureCode, metrics);
      try {
        const stream = raw.execSandbox({ workspaceScope: scope, sandbox, command, noLoginShell: true, executionTimeout: { seconds: 20n }, requestId: randomUUID() }, { timeoutMs: 30_000, signal: AbortSignal.timeout(30_000) });
        for await (const event of stream) {
          if (metrics.eventCount >= maxExecEvents) throw makeError("event_limit");
          metrics.eventCount++;
          if (metrics.exitCode !== undefined) throw makeError("unsupported_event");
          if (event.payload.case === "exit") {
            const value = event.payload.value.exitCode;
            if (!Number.isInteger(value) || value < 0 || value > 255) throw makeError("invalid_exit");
            metrics.exitCode = value;
          } else if (event.payload.case === "stdout" || event.payload.case === "stderr") {
            const channel = event.payload.case;
            const data = event.payload.value.data;
            const remaining = maxExecBytes - metrics.stdoutBytes - metrics.stderrBytes;
            const accepted = Math.min(data.byteLength, remaining);
            metrics[channel === "stdout" ? "stdoutBytes" : "stderrBytes"] += accepted;
            const acceptedData = Buffer.from(data.subarray(0, accepted));
            if (channel === "stdout" && accepted > 0) consumeStdout(acceptedData);
            if (data.byteLength > remaining) throw makeError("output_limit");
            output[channel].push(Buffer.from(data));
          } else throw makeError("unsupported_event");
        }
        consumeStdout(Buffer.alloc(0), true);
        if (metrics.exitCode === undefined) throw makeError("missing_exit");
        return { metrics, stdout: Buffer.concat(output.stdout).toString("utf8"), stderr: Buffer.concat(output.stderr).toString("utf8") };
      } catch (error) {
        if (error instanceof SandboxExecError) throw error;
        throw makeError("rpc_failure");
      }
    };

    stage = "workspace"; log(stage, "start");
    resource = "workspace";
    if (interrupted) throw new Error();
    workspaceState = "unknown";
    const w = (await createResource(state => { workspaceState = state; }, () => raw.createWorkspace({ name: workspace, labels: { "rehor-probe": "memory", "rehor-run-id": runId }, requestId: randomUUID() }, options()))).workspace;
    if (!w?.metadata?.id || w.metadata.name !== workspace || w.metadata.labels["rehor-probe"] !== "memory" || w.metadata.labels["rehor-run-id"] !== runId) throw new Error();
    workspaceId = w.metadata.id; workspaceState = "known";
    const members = await raw.listWorkspaceMembers({ workspaceScope: scope, pageSize: 1 }, options());
    if (members.members.length || members.nextPageToken) throw new Error();
    log(stage, "success");

    stage = "provider"; log(stage, "start");
    resource = "profile";
    if (interrupted) throw new Error();
    profileState = "unknown";
    const imported = await createResource(state => { profileState = state; }, () => raw.importProviderProfiles({ workspaceScope: scope, requestId: randomUUID(), profiles: [{ profile: {
      id: profile, displayName: profile, category: ProviderProfileCategory.OTHER,
      credentials: [{ name: "REHOR_MEMORY_TOKEN", envVars: ["REHOR_MEMORY_TOKEN"], required: true, authStyle: "bearer", headerName: "Authorization" }],
    } }] }, options()));
    if (!imported.imported || imported.profiles.length !== 1 || imported.profiles[0].id !== profile || imported.profiles[0].resourceVersion <= 0n || imported.diagnostics.some(d => d.severity.toLowerCase() === "error")) throw new Error();
    profileVersion = imported.profiles[0].resourceVersion; profileState = "known";
    const savedProfile = (await raw.getProviderProfile({ workspaceScope: scope, id: profile }, options())).profile;
    if (!savedProfile || savedProfile.id !== profile || savedProfile.scope !== "workspace" || savedProfile.source !== "user" || savedProfile.resourceVersion !== profileVersion || savedProfile.category !== ProviderProfileCategory.OTHER || savedProfile.inferenceCapable || savedProfile.endpoints.length || savedProfile.binaries.length || savedProfile.files.length || savedProfile.discovery || savedProfile.credentials.length !== 1) throw new Error();
    const field = savedProfile.credentials[0];
    if (field.name !== "REHOR_MEMORY_TOKEN" || field.envVars.length !== 1 || field.envVars[0] !== "REHOR_MEMORY_TOKEN" || !field.required || field.authStyle !== "bearer" || field.headerName.toLowerCase() !== "authorization" || field.refresh || field.tokenGrant || field.tokenGrantOwners.length || field.queryParam || field.pathTemplate || field.stablePlaceholder) throw new Error();
    if (interrupted) throw new Error();
    const credential = await createCredentialProvider(auth).get();
    if (credential.expiresAt <= Date.now() + 180_000 || interrupted) throw new Error();
    resource = "provider";
    providerState = "unknown";
    const p = (await createResource(state => { providerState = state; }, () => raw.createProvider({ workspaceScope: scope, requestId: randomUUID(), provider: {
      metadata: { name: provider }, type: profile, profileWorkspace: workspace,
      credentials: { REHOR_MEMORY_TOKEN: credential.token },
      credentialExpirationTimes: { REHOR_MEMORY_TOKEN: { seconds: BigInt(Math.floor(credential.expiresAt / 1000)), nanos: (credential.expiresAt % 1000) * 1_000_000 } },
    } }, options()))).provider;
    if (!p?.metadata?.id || p.metadata.name !== provider || p.metadata.workspace !== workspace || p.metadata.resourceVersion <= 0n || p.type !== profile || p.profileWorkspace !== workspace) throw new Error();
    providerId = p.metadata.id; providerVersion = p.metadata.resourceVersion; providerState = "known";
    log(stage, "success");

    stage = "sandbox"; log(stage, "start");
    resource = "sandbox";
    if (interrupted) throw new Error();
    sandboxState = "unknown";
    const s = (await createResource(state => { sandboxState = state; }, () => raw.createSandbox({ workspaceScope: scope, name: sandbox, requestId: randomUUID(), spec: {
      template: { image }, environment: { REHOR_MEMORY_HEALTH_URL: auth.memoryUrl.toString() }, providers: [provider], policy,
      command: [node, "-e", "setInterval(() => {}, 3600000)"], restartPolicy: SandboxRestartPolicy.NEVER,
    } }, options()))).sandbox;
    if (!s?.metadata?.id || s.metadata.name !== sandbox || s.metadata.workspace !== workspace) throw new Error();
    sandboxId = s.metadata.id; sandboxState = "known";
    const deadline = Date.now() + 120_000;
    for (;;) {
      if (interrupted || Date.now() >= deadline) throw new Error();
      const current = (await raw.getSandbox({ workspaceScope: scope, name: sandbox }, options())).sandbox;
      if (current?.metadata?.id !== sandboxId || !current.status) throw new Error();
      if (current.status.phase === SandboxPhase.READY) break;
      if (current.status.phase !== SandboxPhase.PROVISIONING && current.status.phase !== SandboxPhase.STARTING) throw new Error();
      await sleep(1000);
    }
    // Check only supplied settings; Gateway defaults and other permissions are
    // not evaluated. The provider binding has this output-only flag.
    const effective = create(SandboxPolicySchema, policy);
    effective.networkPolicies.memory_health.endpoints[0].providerCredentialed = true;
    const config = await raw.getSandboxConfig({ workspaceScope: scope, name: sandbox }, options());
    const actualRule = config.policy?.networkPolicies.memory_health;
    const filesystem = config.policy?.filesystem;
    if (!config.configurationAdmitted || !actualRule || !equals(NetworkPolicyRuleSchema, effective.networkPolicies.memory_health, actualRule)
        || !filesystem || filesystem.includeWorkdir || !filesystem.readOnly.includes("/opt/probe")) throw new Error();
    for (;;) {
      if (interrupted || Date.now() >= deadline) throw new Error();
      const readiness = (await raw.getSandboxProviderStatus({ workspaceScope: scope, sandbox, provider }, options())).status;
      const desired = readiness?.receipt?.desired, observed = readiness?.observed;
      if (readiness?.state === ProviderReadinessState.READY && desired?.sandboxId === sandboxId && desired.providerId === providerId && desired.providerResourceVersion === providerVersion && desired.attachmentEpoch === config.providerAttachmentEpoch && desired.configRevision === config.configRevision && desired.policyHash === config.policyHash && desired.providerEnvRevision === config.providerEnvRevision && observed?.attachmentEpoch === config.providerAttachmentEpoch && observed.configRevision === config.configRevision && observed.policyHash === config.policyHash && observed.providerEnvRevision === config.providerEnvRevision && observed.credentialsInstalled && observed.policyActive && observed.launchEnvironmentInstalled) break;
      await sleep(1000);
    }
    log(stage, "success");

    stage = "diagnostic"; log(stage, "start");
    resource = undefined;
    if (interrupted) throw new Error();
    const diagnosticExec = await executeSandbox([node, "-e", startupDiagnosticCommand], "diagnostic");
    if (diagnosticExec.metrics.exitCode !== 0) throw new SandboxExecError("diagnostic_nonzero_exit", diagnosticExec.metrics);
    const diagnostic = parseStartupDiagnostic(diagnosticExec.stdout);
    if (!diagnostic) throw new SandboxExecError("diagnostic_invalid_output", diagnosticExec.metrics);
    const diagnosticFailure = startupDiagnosticFailure(diagnostic);
    if (diagnosticFailure) throw new SandboxExecError(diagnosticFailure, diagnosticExec.metrics, diagnostic);
    log(stage, "success", undefined, undefined, undefined, diagnosticExec.metrics, diagnostic);

    stage = "connectivity"; log(stage, "start");
    if (interrupted || credential.expiresAt <= Date.now() + 30_000) throw new Error();
    // Execute the image's probe directly; its fixed markers identify stages.
    const probeExec = await executeSandbox([node, "/opt/probe/probe.js"], "probe");
    const lines = (value: string) => value.split(/\r?\n/);
    if (probeExec.metrics.exitCode !== 0) {
      let category: ProbeLogCode | undefined;
      const probeStarted = probeExec.metrics.markers?.includes("probe-started") ?? false;
      for (const channel of [probeExec.stdout, probeExec.stderr]) {
        for (const line of lines(channel)) {
          if (Object.hasOwn(probeOutputCodes, line)) { category = probeOutputCodes[line]; break; }
        }
        if (category) break;
      }
      if (!category && !probeStarted) category = nodeStartupFailure(probeExec.stderr);
      throw new SandboxExecError(category ?? "probe_nonzero_exit", probeExec.metrics);
    }
    if (interrupted) throw new SandboxExecError("cancelled", probeExec.metrics);
    log(stage, "success", undefined, undefined, undefined, probeExec.metrics);
  } catch (error) {
    failed = true;
    const executionError = error instanceof SandboxExecError ? error : undefined;
    log(stage, "failure", resource, errorCode(error), stage === "connectivity" ? executionError?.metrics.exitCode : undefined, executionError?.metrics, executionError?.diagnostic);
  } finally {
    stage = "cleanup"; log(stage, "start");
    if (client) {
      const raw = client.raw;
      const notFound = (e: unknown) => e instanceof ConnectError && e.code === Code.NotFound;
      try {
        const checkWorkspace = async () => {
          const w = (await raw.getWorkspace({ name: workspace }, options())).workspace;
          if (w?.metadata?.id !== workspaceId || w.metadata.name !== workspace || w.metadata.labels["rehor-probe"] !== "memory" || w.metadata.labels["rehor-run-id"] !== runId) throw new Error();
        };
        if (workspaceState === "unknown") throw new Error();
        if (workspaceState === "known") {
          await checkWorkspace();
          cleanupResource = "sandbox";
          if (sandboxState === "unknown") throw new Error();
          if (sandboxState === "known") {
            const s = (await raw.getSandbox({ workspaceScope: scope, name: sandbox }, options())).sandbox;
            if (s?.metadata?.id !== sandboxId || s.metadata.workspace !== workspace) throw new Error();
            sandboxState = "unknown";
            const d = await raw.deleteSandbox({ workspaceScope: scope, name: sandbox, requestId: randomUUID() }, options());
            if (d.sandboxId !== sandboxId || (d.outcome !== DeletionOutcome.ACCEPTED && d.outcome !== DeletionOutcome.COMPLETED)) throw new Error();
            sandboxDeleteOutcome = d.outcome === DeletionOutcome.ACCEPTED ? "accepted" : "completed";
            const deadline = Date.now() + 30_000;
            for (;;) {
              if (interrupted) throw new Error();
              try {
                const current = (await raw.getSandbox({ workspaceScope: scope, name: sandbox }, options())).sandbox;
                if (current?.metadata?.id !== sandboxId || current.metadata.workspace !== workspace) throw new Error();
                sandboxState = "known";
              }
              catch (e) { if (notFound(e)) break; throw e; }
              if (Date.now() >= deadline) {
                sandboxDeletePending = true;
                acceptedSandboxDeletePending = sandboxDeleteOutcome === "accepted";
                throw new Error();
              }
              await sleep(500);
            }
            sandboxState = "none";
          }
          cleanupResource = "provider";
          if (providerState === "unknown") throw new Error();
          if (providerState === "known") {
            await checkWorkspace();
            const p = (await raw.getProvider({ workspaceScope: scope, name: provider }, options())).provider;
            if (p?.metadata?.id !== providerId || p.metadata.resourceVersion !== providerVersion || p.metadata.workspace !== workspace) throw new Error();
            providerState = "unknown";
            const d = await raw.deleteProvider({ workspaceScope: scope, name: provider, requestId: randomUUID() }, options());
            if (d.outcome !== DeletionOutcome.COMPLETED) throw new Error();
            try { await raw.getProvider({ workspaceScope: scope, name: provider }, options()); throw new Error(); }
            catch (e) { if (!notFound(e)) throw e; }
            providerState = "none";
          }
          cleanupResource = "profile";
          if (profileState === "unknown") throw new Error();
          if (profileState === "known") {
            await checkWorkspace();
            const p = (await raw.getProviderProfile({ workspaceScope: scope, id: profile }, options())).profile;
            if (p?.id !== profile || p.scope !== "workspace" || p.resourceVersion !== profileVersion) throw new Error();
            profileState = "unknown";
            const d = await raw.deleteProviderProfile({ workspaceScope: scope, id: profile, requestId: randomUUID() }, options());
            if (d.outcome !== DeletionOutcome.COMPLETED) throw new Error();
            try { await raw.getProviderProfile({ workspaceScope: scope, id: profile }, options()); throw new Error(); }
            catch (e) { if (!notFound(e)) throw e; }
            profileState = "none";
          }
          cleanupResource = "workspace";
          await checkWorkspace();
          const page = { workspaceScope: scope, pageSize: 1 };
          const [members, sandboxes, providers, templates, services] = await Promise.all([
            raw.listWorkspaceMembers(page, options()), raw.listSandboxes(page, options()), raw.listProviders(page, options()), raw.listSandboxTemplates(page, options()), raw.listServices(page, options()),
          ]);
          if (members.members.length || members.nextPageToken || sandboxes.sandboxes.length || sandboxes.nextPageToken || providers.providers.length || providers.nextPageToken || templates.templates.length || templates.nextPageToken || services.services.length || services.nextPageToken) throw new Error();
          let cursor = "";
          const seen = new Set<string>();
          for (let n = 0; ; n++) {
            if (n >= 100) throw new Error();
            const profiles = await raw.listProviderProfiles({ workspaceScope: scope, pageSize: 100, pageToken: cursor }, options());
            if (profiles.profiles.some(p => p.scope !== "platform")) throw new Error();
            if (!profiles.nextPageToken) break;
            if (seen.has(profiles.nextPageToken)) throw new Error();
            seen.add(profiles.nextPageToken); cursor = profiles.nextPageToken;
          }
          await checkWorkspace();
          workspaceState = "unknown";
          const d = await raw.deleteWorkspace({ name: workspace, requestId: randomUUID() }, options());
          if (d.outcome !== DeletionOutcome.COMPLETED) throw new Error();
          try { await raw.getWorkspace({ name: workspace }, options()); throw new Error(); }
          catch (e) { if (!notFound(e)) throw e; }
          workspaceState = "none";
        }
      } catch (error) {
        incomplete = true;
        const deletionPending = acceptedSandboxDeletePending;
        const ambiguous = workspaceState === "unknown" || profileState === "unknown" || providerState === "unknown" || sandboxState === "unknown" || (sandboxDeletePending && sandboxDeleteOutcome === "completed");
        log("cleanup", "incomplete", deletionPending ? "sandbox" : cleanupResource, deletionPending ? "deletion_pending" : ambiguous ? "ambiguous" : errorCode(error), undefined, undefined, undefined, deletionPending ? "accepted" : undefined);
      }
    }
    if (!incomplete) log(stage, "success");
    process.off("SIGINT", stop); process.off("SIGTERM", stop);
  }
  if (failed || (incomplete && !acceptedSandboxDeletePending) || interrupted) process.exitCode = 1;
}

const runId = randomUUID();
void main(runId).catch(() => { writeProbeLog(runId, "cleanup", "incomplete", undefined, "other"); process.exitCode = 1; });
