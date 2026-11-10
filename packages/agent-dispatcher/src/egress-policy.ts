import { create } from "@bufbuild/protobuf";
import type { SandboxSpec } from "@nvidia/openshell-sdk";
import { NetworkEnforcementMode, NetworkPolicyRuleSchema, NetworkTlsMode } from "@nvidia/openshell-sdk/raw";

/** Centrally compiled public-egress policy (REHOR-253).
 *
 * Ordinary (non-credential-bearing) sandbox egress is migrated from the
 * legacy Squid `allowed_domains` allowlist (`proxy/squid.conf`, 2026-11-04
 * revision) into this static, dispatcher-owned classification. Squid itself
 * stays byte-for-byte unchanged for legacy deployments; this module is the
 * forward-looking supervisor policy, merged into the sandbox bootstrap
 * policy only when the global deployment flag enables it.
 *
 * Ownership is closed: the rule set is a compile-time constant. Teams,
 * agent instance configs, profiles, and `preflightEnv` contribute nothing —
 * there is no per-instance knob by design.
 *
 * Auth-bearing hub destinations are intentionally EXCLUDED: they stay on
 * the HTTP OAuth gateway (vendor credentials are injected there, never via
 * OpenShell supervisor policy). Each exclusion below is a deliberate
 * classification decision, and the parity test in
 * `test/egress-policy.test.mjs` fails when the Squid allowlist and this
 * classification drift apart.
 *
 * Host semantics (verified against the OpenShell supervisor policy engine):
 * exact hosts match case-insensitively; `**.<domain>` matches the domain's
 * subdomains across label boundaries, mirroring Squid's leading-dot
 * `dstdomain` form. Squid's `<domain>` (no leading dot) is exact-only and
 * maps to a single exact endpoint. Anything the SDK cannot express without
 * broadening is denied instead.
 *
 * SECURITY INVARIANT (enforced in code and tests): every public egress
 * endpoint MUST use L4-only protocol "" with NetworkTlsMode.SKIP and no
 * credentialBinding. SKIP disables supervisor TLS interception, NOT the
 * client's own TLS verification. The hub memory and model-gateway rules
 * keep their existing shape and are unchanged. The enabling flag stays
 * at its default false. */

type SandboxPolicy = NonNullable<SandboxSpec["policy"]>;

export type EgressMatch = "exact" | "domain-and-subdomains";

export type EgressDestination = {
  /** Base domain as it appears (minus any leading dot) in the Squid allowlist. */
  host: string;
  match: EgressMatch;
  /** What the destination is used for; grounds the classification review. */
  service: string;
};

/** Direct public destinations (HTTPS 443 only) granted to the reviewed
 * system toolset. Derived one-to-one from the Squid allowlist entries that
 * are not auth-bearing. */
export const PUBLIC_EGRESS_DESTINATIONS: readonly EgressDestination[] = [
  // GitHub: git-over-HTTPS transport, raw/archive downloads. Authenticated
  // gh/glab API calls go through the executor gateway, not sandbox egress.
  { host: "github.com", match: "domain-and-subdomains", service: "git-over-HTTPS and raw content" },
  { host: "githubusercontent.com", match: "domain-and-subdomains", service: "GitHub raw/archive content" },
  // Package registries.
  { host: "npmjs.org", match: "domain-and-subdomains", service: "npm registry" },
  { host: "nodejs.org", match: "domain-and-subdomains", service: "Node.js distribution tarballs" },
  { host: "pypi.org", match: "exact", service: "Python package index" },
  { host: "files.pythonhosted.org", match: "exact", service: "Python package downloads" },
  { host: "pypi.python.org", match: "exact", service: "legacy Python package index" },
  { host: "download.pytorch.org", match: "exact", service: "PyTorch package index" },
  // Playwright browser downloads (the download itself; see binaries note).
  { host: "cdn.playwright.dev", match: "exact", service: "Playwright browser downloads" },
  { host: "playwright.download.prss.microsoft.com", match: "exact", service: "Playwright browser downloads" },
  // Go toolchain and modules.
  { host: "go.dev", match: "exact", service: "Go toolchain downloads" },
  { host: "dl.google.com", match: "exact", service: "Go toolchain downloads" },
  { host: "proxy.golang.org", match: "exact", service: "Go module proxy" },
  { host: "sum.golang.org", match: "exact", service: "Go checksum database" },
  // Carved out of the gateway-only googleapis.com domain: public object
  // storage used for Go toolchain and other ordinary downloads.
  { host: "storage.googleapis.com", match: "exact", service: "public object storage downloads" },
  // Container tooling: public Quay registry reads and layer CDN.
  { host: "quay.io", match: "exact", service: "public Quay registry API" },
  { host: "cdn.quay.io", match: "exact", service: "Quay layer CDN" },
  { host: "cdn01.quay.io", match: "exact", service: "Quay layer CDN" },
  { host: "cdn02.quay.io", match: "exact", service: "Quay layer CDN" },
  { host: "cdn03.quay.io", match: "exact", service: "Quay layer CDN" },
  { host: "anchore.io", match: "domain-and-subdomains", service: "Grype vulnerability database" },
  // Distro package mirrors.
  { host: "fedoraproject.org", match: "domain-and-subdomains", service: "Fedora package mirrors" },
];

/** Auth-bearing hub destinations that stay on the HTTP OAuth gateway and are
 * intentionally absent from the sandbox egress rule. */
export const GATEWAY_ONLY_DESTINATIONS: readonly EgressDestination[] = [
  { host: "atlassian.net", match: "domain-and-subdomains", service: "Jira (authenticated hub API)" },
  // Vertex AI and other authenticated Google APIs. storage.googleapis.com is
  // carved out above as a direct download destination.
  { host: "googleapis.com", match: "domain-and-subdomains", service: "Vertex AI (authenticated hub API)" },
  { host: "redhat.com", match: "domain-and-subdomains", service: "Red Hat SSO and authenticated registry access" },
  { host: "registry.redhat.io", match: "exact", service: "authenticated Red Hat registry" },
  { host: "glitchtip.devshift.net", match: "exact", service: "GlitchTip error tracking (DSN-embedded credentials)" },
];

/** Squid allowed ports intentionally not granted: SSH 22 (use git over
 * HTTPS) and plain HTTP 80 (HTTPS-only egress). Squid also listed 443,
 * which this policy grants exclusively. */
export const EXCLUDED_SQUID_PORTS: readonly { port: number; reason: string }[] = [
  { port: 22, reason: "SSH tunneled via CONNECT is not granted; use git over HTTPS" },
  { port: 80, reason: "plain HTTP is not granted; ordinary downloads are HTTPS-only" },
];

/** Reviewed system toolset allowed to open ordinary public egress, matched
 * by the supervisor against the exact executable path (symlinks resolved)
 * or an ancestor process. Grounded in Dockerfile.runner and the env presets:
 *
 * - /usr/bin/git, /usr/bin/curl, /usr/bin/python3.12 — base image dnf install
 * - /usr/local/bin/uv — base image pip3.12 install
 * - /usr/local/bin/node — coordinator-builder COPY (real file when the node
 *   preset is not installed)
 * - /usr/local/bin/grype — container-scan preset tarball install
 * - /usr/local/nvm/versions/node/<version>/bin/node — node preset (NVM_DIR)
 * - /usr/local/goenv/versions/<version>/bin/go — go preset (GOENV_ROOT)
 * - /usr/local/pyenv/versions/<version>/bin/python — python preset (PYENV_ROOT)
 *
 * The version-label globs are single path segments under fixed root-owned
 * image-build roots; no writable executable location is ever globbed.
 *
 * Known limitation (flagged, not wildcarded): the Playwright browser
 * executable lives at a version-dynamic path under /opt/pw-browsers and is
 * NOT granted network egress; the browser download itself is performed by
 * node/npx, which is covered. E2E tests must use local servers. */
const REVIEWED_EGRESS_BINARIES: readonly string[] = [
  "/usr/bin/git",
  "/usr/bin/curl",
  "/usr/bin/python3.12",
  "/usr/local/bin/uv",
  "/usr/local/bin/node",
  "/usr/local/bin/grype",
  "/usr/local/nvm/versions/node/*/bin/node",
  "/usr/local/goenv/versions/*/bin/go",
  "/usr/local/pyenv/versions/*/bin/python",
];

const PUBLIC_EGRESS_RULE_KEY = "public_egress";
const PUBLIC_EGRESS_HTTPS_PORT = 443;

export function publicEgressRuleKey(): string {
  return PUBLIC_EGRESS_RULE_KEY;
}

/** Deterministic static rule; takes no input by construction so no team,
 * instance, profile, or environment value can alter it. Built as a real
 * protocol-buffer message (like the session-side verification policy) so
 * the merged map stays type-compatible with the SDK's policy shape. */
export function createPublicEgressRule() {
  const endpoints = [];
  for (const destination of PUBLIC_EGRESS_DESTINATIONS) {
    // A leading-dot dstdomain means the domain itself plus subdomains; only
    // the exact host plus a recursive subdomain pattern reproduces that
    // without broadening. Single-label "*" would miss deeper subdomains.
    const hosts = destination.match === "domain-and-subdomains"
      ? [destination.host, `**.${destination.host}`]
      : [destination.host];
    for (const host of hosts) {
      endpoints.push({
        host,
        port: PUBLIC_EGRESS_HTTPS_PORT,
        // Security invariant: L4-only raw TLS tunnel, no credential
        // binding. SKIP means no supervisor interception, not disabled
        // client TLS verification.
        protocol: "",
        tls: NetworkTlsMode.SKIP,
        enforcement: NetworkEnforcementMode.ENFORCE,
      });
    }
  }
  return create(NetworkPolicyRuleSchema, {
    name: "public-egress",
    endpoints,
    binaries: REVIEWED_EGRESS_BINARIES.map((path) => ({ path })),
  });
}

/** Merge the static public-egress rule into a sandbox policy at
 * construction time (REHOR-253). Disabled by default: the flag is false
 * until an approved rollout, leaving current behavior byte-identical. */
export function withPublicEgress(policy: SandboxPolicy, enabled: boolean): SandboxPolicy {
  if (!enabled) return policy;
  const existing = policy.networkPolicies ?? {};
  if (existing[PUBLIC_EGRESS_RULE_KEY] !== undefined) {
    throw new Error("Public egress rule key is reserved");
  }
  return { ...policy, networkPolicies: { ...existing, [PUBLIC_EGRESS_RULE_KEY]: createPublicEgressRule() } };
}
