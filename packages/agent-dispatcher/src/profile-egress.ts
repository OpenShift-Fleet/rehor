import { isIP } from "node:net";

export type SandboxEgressRequest = Readonly<{ host: string; port: 443 }>;

const dnsLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const nonPublicSuffixes = new Set(["localhost", "local", "localdomain", "internal", "lan", "corp", "home", "onion", "invalid", "test", "example", "arpa"]);

function exactPublicHostname(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 253) return false;
  const labels = value.split(".");
  const suffix = labels.at(-1)!;
  if (labels.length < 2 || labels.some((label) => !dnsLabel.test(label) || label.startsWith("xn--"))
    || nonPublicSuffixes.has(suffix)) return false;
  // Reject noncanonical IPv4 forms as well as ordinary IP literals. URL
  // parsing is purely syntactic here and does not resolve the hostname.
  try {
    const { hostname } = new URL(`https://${value}`);
    return hostname === value && isIP(hostname) === 0;
  } catch {
    return false;
  }
}

export function parseSandboxEgress(value: unknown): SandboxEgressRequest[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32) throw new Error("sandbox.egress must be a list of at most 32 destinations");
  const hosts = new Set<string>();
  return Array.from(value, (entry, index) => {
    const where = `sandbox.egress[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)
      || Object.keys(entry).length !== 2 || !Object.hasOwn(entry, "host") || !Object.hasOwn(entry, "port")) {
      throw new Error(`${where} must contain only host and port`);
    }
    const { host, port } = entry;
    if (!exactPublicHostname(host)) throw new Error(`${where}.host must be an exact lowercase public DNS hostname`);
    if (port !== 443) throw new Error(`${where}.port must be 443`);
    if (hosts.has(host)) throw new Error(`${where} duplicates a destination`);
    hosts.add(host);
    return { host, port };
  });
}
