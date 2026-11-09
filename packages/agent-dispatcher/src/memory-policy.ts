import type { SandboxSpec } from "@nvidia/openshell-sdk";
import { NetworkEnforcementMode, NetworkTlsMode } from "@nvidia/openshell-sdk/raw";
import type { RuntimeLayout } from "./runtime-layout.js";

/** Constrained bootstrap policy, NOT complete agent runtime networking.
 * Only the HTTPS health route is authorized, plus an optional model-gateway
 * rule admitting the OpenAI-compatible /v1 API when a proxy URL is supplied.
 * REHOR-215 must map runner/memory MCP/proxy services; REHOR-233 must verify
 * runtime filesystem compatibility. No HTTP credential transport or broad
 * egress is inferred from runner env. */
export function createMemoryPolicy(memoryUrl: URL, provider: string, runtime: RuntimeLayout = { kind: "legacy" }, modelProxyUrl?: URL): NonNullable<SandboxSpec["policy"]> {
  if (memoryUrl.protocol !== "https:" || memoryUrl.username || memoryUrl.password || memoryUrl.search || memoryUrl.hash
    || memoryUrl.pathname !== "/health" || !/^[a-z0-9.-]+$/.test(memoryUrl.hostname)
    || !/^[a-z0-9](?:[a-z0-9-]{0,17}[a-z0-9])?$/.test(provider)) {
    throw new Error("Invalid memory policy configuration");
  }
  if (modelProxyUrl !== undefined
    && (modelProxyUrl.protocol !== "https:" || modelProxyUrl.username || modelProxyUrl.password || modelProxyUrl.search || modelProxyUrl.hash
      || /[?#]$/.test(modelProxyUrl.href)
      || modelProxyUrl.pathname !== "/v1" || !/^[a-z0-9.-]+$/.test(modelProxyUrl.hostname))) {
    throw new Error("Invalid model proxy policy configuration");
  }
  return {
    version: 1,
    filesystem: runtime.kind === "private"
      ? { includeWorkdir: false, readOnly: [...new Set(["/opt/rehor", "/opt/opencode", runtime.source])], readWrite: [...new Set(["/tmp", runtime.parent])] }
      : { includeWorkdir: false, readOnly: ["/home/botuser/app"], readWrite: ["/home/botuser/repos", "/home/botuser/data", "/tmp"] },
    networkPolicies: {
      memory_health: {
        name: "memory-health",
        endpoints: [{
          host: memoryUrl.hostname, port: memoryUrl.port ? Number(memoryUrl.port) : 443,
          protocol: "rest", tls: NetworkTlsMode.UNSPECIFIED, enforcement: NetworkEnforcementMode.ENFORCE,
          path: "/health", rules: [{ allow: { method: "GET", path: "/health" } }], credentialBinding: { provider },
        }],
        binaries: [{ path: "/usr/bin/python3.12" }],
      },
      ...(modelProxyUrl === undefined ? {} : {
        model_proxy: {
          name: "model-proxy",
          endpoints: [{
            host: modelProxyUrl.hostname, port: modelProxyUrl.port ? Number(modelProxyUrl.port) : 443,
            protocol: "rest", tls: NetworkTlsMode.UNSPECIFIED, enforcement: NetworkEnforcementMode.ENFORCE,
            // OpenShell matches the endpoint path and the allow-rule paths
            // separately: /v1 never matches /v1/models, so the endpoint scope
            // must be the /v1 subtree.
            path: "/v1/**", rules: [
              { allow: { method: "GET", path: "/v1/models" } },
              { allow: { method: "POST", path: "/v1/chat/completions" } },
              { allow: { method: "POST", path: "/v1/responses" } },
            ], credentialBinding: { provider },
          }],
          binaries: [{ path: "/opt/opencode/bin/opencode" }, { path: "/usr/local/bin/node" }],
        },
      }),
    },
  };
}
