import type { SandboxSpec } from "@nvidia/openshell-sdk";
import { NetworkEnforcementMode, NetworkTlsMode } from "@nvidia/openshell-sdk/raw";
import type { RuntimeLayout } from "./runtime-layout.js";

export interface MemoryPolicyOptions {
  memoryRuntime?: boolean;
  serviceGatewayUrl?: URL;
}

/** Constrained bootstrap policy with explicitly opted-in runtime services.
 * No HTTP credential transport or broad egress is inferred from runner env. */
export function createMemoryPolicy(memoryUrl: URL, provider: string, runtime: RuntimeLayout = { kind: "legacy" }, modelProxyUrl?: URL, options: MemoryPolicyOptions = {}): NonNullable<SandboxSpec["policy"]> {
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
  if (options.memoryRuntime && /[?#]$/.test(memoryUrl.href)) {
    throw new Error("Invalid memory policy configuration");
  }
  const serviceGatewayUrl = options.serviceGatewayUrl;
  if (serviceGatewayUrl !== undefined) {
    const labels = serviceGatewayUrl.hostname.split(".");
    if (serviceGatewayUrl.protocol !== "https:" || serviceGatewayUrl.username || serviceGatewayUrl.password
      || serviceGatewayUrl.pathname !== "/" || serviceGatewayUrl.search || serviceGatewayUrl.hash
      || /[?#]$/.test(serviceGatewayUrl.href) || serviceGatewayUrl.port === "0"
      || serviceGatewayUrl.hostname.length > 253
      || labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
      || serviceGatewayUrl.host === memoryUrl.host || serviceGatewayUrl.host === modelProxyUrl?.host) {
      throw new Error("Invalid service gateway policy configuration");
    }
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
      ...(options.memoryRuntime ? {
        memory_runtime: {
          name: "memory-runtime",
          endpoints: [
            { path: "/mcp", methods: ["GET", "POST", "DELETE"] },
            { path: "/api/tasks", methods: ["GET"] },
            { path: "/api/bot-status", methods: ["POST"] },
            { path: "/api/costs", methods: ["POST"] },
            { path: "/api/cycle-runs", methods: ["POST"] },
          ].map(({ path, methods }) => ({
            host: memoryUrl.hostname, port: memoryUrl.port ? Number(memoryUrl.port) : 443,
            protocol: "rest", tls: NetworkTlsMode.UNSPECIFIED, enforcement: NetworkEnforcementMode.ENFORCE,
            path, rules: methods.map((method) => ({ allow: { method, path } })), credentialBinding: { provider },
          })),
          binaries: [{ path: "/usr/bin/python3.12" }, { path: "/usr/local/bin/node" }, { path: "/opt/opencode/bin/opencode" }],
        },
      } : {}),
      ...(serviceGatewayUrl === undefined ? {} : {
        service_gateway_jira: {
          name: "service-gateway-jira",
          endpoints: [{
            host: serviceGatewayUrl.hostname, port: serviceGatewayUrl.port ? Number(serviceGatewayUrl.port) : 443,
            protocol: "rest", tls: NetworkTlsMode.UNSPECIFIED, enforcement: NetworkEnforcementMode.ENFORCE,
            path: "/jira/mcp", rules: ["GET", "POST", "DELETE"].map((method) => ({ allow: { method, path: "/jira/mcp" } })),
            credentialBinding: { provider },
          }],
          binaries: [{ path: "/usr/bin/python3.12" }, { path: "/usr/local/bin/node" }, { path: "/opt/opencode/bin/opencode" }],
        },
        service_gateway_executor: {
          name: "service-gateway-executor",
          endpoints: [{
            host: serviceGatewayUrl.hostname, port: serviceGatewayUrl.port ? Number(serviceGatewayUrl.port) : 443,
            protocol: "rest", tls: NetworkTlsMode.UNSPECIFIED, enforcement: NetworkEnforcementMode.ENFORCE,
            path: "/executor/execute", rules: [{ allow: { method: "POST", path: "/executor/execute" } }],
            credentialBinding: { provider },
          }],
          binaries: ["executor-client", "gh", "glab", "gpg"].map((name) => ({ path: `/usr/local/bin/${name}` })),
        },
        service_gateway_git: {
          name: "service-gateway-git",
          endpoints: [{
            host: serviceGatewayUrl.hostname, port: serviceGatewayUrl.port ? Number(serviceGatewayUrl.port) : 443,
            protocol: "rest", tls: NetworkTlsMode.UNSPECIFIED, enforcement: NetworkEnforcementMode.ENFORCE,
            path: "/git/**", rules: ["GET", "POST"].map((method) => ({ allow: { method, path: "/git/**" } })),
            credentialBinding: { provider },
          }],
          // Dockerfile.runner installs UBI9 Git. The UBI9 git-core RPM lists
          // both helpers; the deployed image's exec path and supervisor's
          // resolved executable identity still require runtime verification.
          binaries: [{ path: "/usr/libexec/git-core/git-remote-https" }, { path: "/usr/libexec/git-core/git-remote-http" }],
        },
      }),
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
