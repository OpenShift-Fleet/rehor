import type { SandboxSpec } from "@nvidia/openshell-sdk";
import { NetworkEnforcementMode, NetworkTlsMode } from "@nvidia/openshell-sdk/raw";
import { isIP } from "node:net";

export type MemorySandboxPolicyOptions = {
  memoryUrl: string;
  nodeBinaryPath: string;
  providerName: string;
  allowedIps?: readonly string[];
};

/**
 * Build the create-time network policy for an endpointless, attached provider.
 * This does not attach the provider or create a sandbox, and does not evaluate
 * the effect of additional global/provider rules.
 *
 * OpenShell auto-detects TLS: this policy does not itself require TLS for
 * plaintext sent to the same host and port, nor does it reject query strings
 * on matching requests. The workload and upstream must enforce those bounds.
 * By default OpenShell's internal-IP SSRF check applies. Explicit allowedIps
 * replaces that check, so only individually approved IPv4 addresses are
 * accepted; no ranges or implicit DNS lookup are provided here.
 */
export function createMemorySandboxPolicy(options: MemorySandboxPolicyOptions): NonNullable<SandboxSpec["policy"]> {
  const invalid = () => { throw new Error("Invalid memory sandbox policy configuration"); };
  if (!options || typeof options !== "object" || Object.keys(options).some((key) => !["memoryUrl", "nodeBinaryPath", "providerName", "allowedIps"].includes(key))) return invalid();
  const { memoryUrl, nodeBinaryPath, providerName, allowedIps } = options;

  // Avoid URL normalization of userinfo, dot segments, backslashes, escaped
  // glob characters, and empty query/fragment delimiters before validation.
  if (typeof memoryUrl !== "string" || /[^\x21-\x7e]/.test(memoryUrl)) return invalid();
  const match = /^https:\/\/([a-zA-Z0-9.-]+)(?::([0-9]+))?(\/[^?#]*)$/.exec(memoryUrl);
  if (!match) return invalid();
  const [, rawHost, rawPort, path] = match;
  const host = rawHost.toLowerCase();
  const labels = host.split(".");
  if (host.length > 253 || labels.some((label) => label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) return invalid();
  // Only canonical IPv4 literals are accepted; URL parsers reinterpret short
  // or numeric forms (e.g. 127.1) and could target a different host.
  if (/^[0-9.]+$/.test(host) && (labels.length !== 4 || labels.some((part) => !/^(0|[1-9][0-9]{0,2})$/.test(part) || Number(part) > 255))) return invalid();
  const port = rawPort === undefined ? 443 : Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return invalid();
  // Conservative literal paths only: no percent encodings, wildcard syntax,
  // empty or dot segments, or URL parser path normalization.
  const segments = path.slice(1).split("/");
  if (path !== "/health" || segments.some((segment) => !/^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/.test(segment) || segment === "." || segment === "..")) return invalid();
  if (typeof nodeBinaryPath !== "string" || nodeBinaryPath.length > 4096
      || /[^\x21-\x7e]/.test(nodeBinaryPath)
      || !/^\/(?:[a-zA-Z0-9_-][a-zA-Z0-9._-]*\/)*(?:node(?:-[1-9][0-9]*)?|nodejs)$/.test(nodeBinaryPath)) return invalid();
  if (typeof providerName !== "string" || providerName.length > 63 || /[^\x21-\x7e]/.test(providerName)
      || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(providerName)) return invalid();
  let approvedIps: string[] | undefined;
  if (allowedIps !== undefined) {
    if (!Array.isArray(allowedIps) || allowedIps.length < 1 || allowedIps.length > 16) return invalid();
    approvedIps = [];
    for (const ip of allowedIps) {
      if (typeof ip !== "string" || isIP(ip) !== 4 || approvedIps.includes(ip)) return invalid();
      const [first, second] = ip.split(".").map(Number);
      // OpenShell blocks loopback and link-local even with allowedIps. Also
      // disallow unspecified, broadcast, multicast and reserved IPv4 space.
      if (first === 0 || first === 127 || first >= 224 || (first === 169 && second === 254)) return invalid();
      approvedIps.push(ip);
    }
  }

  return {
    version: 1,
    // Keep the mounted probe tree read-only, including when it is the image
    // workdir. OpenShell v0.1.5's proxy-mode supervisor enriches baseline
    // runtime paths additively; do not duplicate its image-dependent path list.
    filesystem: { includeWorkdir: false, readOnly: ["/opt/probe"], readWrite: [] },
    networkPolicies: {
      memory_health: {
        name: "memory-health",
        endpoints: [{
          host, port, protocol: "rest", tls: NetworkTlsMode.UNSPECIFIED,
          enforcement: NetworkEnforcementMode.ENFORCE,
          path,
          rules: [{ allow: { method: "GET", path } }],
          credentialBinding: { provider: providerName },
          ...(approvedIps ? { allowedIps: approvedIps } : {}),
        }],
        binaries: [{ path: nodeBinaryPath }],
      },
    },
  };
}
