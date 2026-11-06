import type { SandboxSpec } from "@nvidia/openshell-sdk";
import { NetworkEnforcementMode, NetworkTlsMode } from "@nvidia/openshell-sdk/raw";
import type { RuntimeLayout } from "./runtime-layout.js";

/** Constrained bootstrap policy, NOT complete agent runtime networking.
 * Only the HTTPS health route is authorized. REHOR-215 must map runner/memory
 * MCP/proxy services; REHOR-233 must verify runtime filesystem compatibility.
 * No HTTP credential transport or broad egress is inferred from runner env. */
export function createMemoryPolicy(memoryUrl: URL, provider: string, runtime: RuntimeLayout = { kind: "legacy" }): NonNullable<SandboxSpec["policy"]> {
  if (memoryUrl.protocol !== "https:" || memoryUrl.username || memoryUrl.password || memoryUrl.search || memoryUrl.hash
    || memoryUrl.pathname !== "/health" || !/^[a-z0-9.-]+$/.test(memoryUrl.hostname)
    || !/^[a-z0-9](?:[a-z0-9-]{0,17}[a-z0-9])?$/.test(provider)) {
    throw new Error("Invalid memory policy configuration");
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
    },
  };
}
