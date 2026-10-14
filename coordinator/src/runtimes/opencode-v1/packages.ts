import {
  OPENCODE_PACKAGE_LOCK_VERSION,
  OpenCodeConfigValidationError,
  type OpenCodePackage,
  type OpenCodePackageLock,
  type OpenCodePluginConfig,
  type OpenCodeProviderConfig,
} from "./types";

const EXACT_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
// OpenCode 1.18.29 matches bundled adapters by exact bare npm name. Version
// suffixes bypass its bundled loader and trigger dynamic installation offline.
const BUNDLED_PROVIDER_PACKAGES: ReadonlySet<string> = new Set([
  "@ai-sdk/openai",
  "@ai-sdk/openai-compatible",
]);

/** Collapse package declarations into one immutable lock source. */
export function normalizePackageLock(
  packages: readonly OpenCodePackage[],
  plugins: readonly OpenCodePluginConfig[],
  providers: readonly OpenCodeProviderConfig[],
): OpenCodePackageLock {
  const values = new Map<string, string>();
  for (const item of packages) addPackage(values, item.name, item.version, "packages");
  for (const plugin of plugins) {
    const reference = parsePackageReference(plugin.name);
    if (reference === undefined) {
      throw new OpenCodeConfigValidationError([
        `plugins must use a declared npm package, got '${plugin.name}'`,
      ]);
    }
    addPackage(values, reference.name, plugin.version, "plugins");
  }
  for (const provider of providers) {
    if (provider.npm === undefined) continue;
    const reference = parsePackageReference(provider.npm);
    if (reference?.version !== undefined) {
      addPackage(values, reference.name, reference.version, `provider.${provider.id}.npm`);
    }
  }
  return {
    lockfileVersion: OPENCODE_PACKAGE_LOCK_VERSION,
    packages: Object.fromEntries(
      [...values.entries()].sort(([left], [right]) => left.localeCompare(right)),
    ),
  };
}

function addPackage(
  values: Map<string, string>,
  name: string,
  version: string,
  path: string,
): void {
  if (!isPackageName(name))
    throw new OpenCodeConfigValidationError([`${path} contains invalid package '${name}'`]);
  if (!EXACT_VERSION.test(version)) {
    throw new OpenCodeConfigValidationError([
      `${path}.${name} must use an exact version, got '${version}'`,
    ]);
  }
  const existing = values.get(name);
  if (existing !== undefined && existing !== version) {
    throw new OpenCodeConfigValidationError([
      `package '${name}' has conflicting pinned versions '${existing}' and '${version}'`,
    ]);
  }
  values.set(name, version);
}

export function pinPackageReference(
  rawSpec: string,
  packageLock: OpenCodePackageLock,
  path: string,
  useBundledProvider = false,
): string {
  const parsed = parsePackageReference(rawSpec);
  if (parsed === undefined) {
    throw new OpenCodeConfigValidationError([
      `${path} must use a declared npm package, got '${rawSpec}'`,
    ]);
  }
  const pinned = packageLock.packages[parsed.name];
  if (pinned === undefined) {
    throw new OpenCodeConfigValidationError([
      `package '${parsed.name}' is not declared with an exact version for ${path}`,
    ]);
  }
  if (parsed.version !== undefined && parsed.version !== pinned) {
    throw new OpenCodeConfigValidationError([
      `${path} pins '${parsed.name}@${parsed.version}' but package lock has '${pinned}'`,
    ]);
  }
  return useBundledProvider && BUNDLED_PROVIDER_PACKAGES.has(parsed.name)
    ? parsed.name
    : `${parsed.name}@${pinned}`;
}

function parsePackageReference(rawSpec: string): { name: string; version?: string } | undefined {
  const spec = rawSpec.startsWith("npm:") ? rawSpec.slice("npm:".length) : rawSpec;
  if (spec.startsWith("file:") || spec.startsWith(".") || spec.startsWith("/")) return undefined;
  const separator = spec.indexOf("@", spec.startsWith("@") ? 1 : 0);
  if (separator < 0) return { name: spec };
  return { name: spec.slice(0, separator), version: spec.slice(separator + 1) };
}

function isPackageName(value: string): boolean {
  return value.startsWith("@")
    ? /^@[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(value)
    : /^[a-zA-Z0-9._-]+$/.test(value);
}
