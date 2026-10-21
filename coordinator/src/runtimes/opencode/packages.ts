import {
  OPENCODE_PACKAGE_LOCK_VERSION,
  OpenCodeConfigValidationError,
  type OpenCodePackage,
  type OpenCodePackageLock,
  type OpenCodePluginConfig,
  type OpenCodeProviderConfig,
} from "./types";

const EXACT_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const BUNDLED = new Set([
  "@opencode/ai/providers/openai",
  "@opencode/ai/providers/openai/chat",
  "@opencode/ai/providers/openai/responses",
  "@opencode/ai/providers/openai-compatible",
]);

export function normalizePackageLock(
  packages: readonly OpenCodePackage[],
  plugins: readonly OpenCodePluginConfig[],
  providers: readonly OpenCodeProviderConfig[],
): OpenCodePackageLock {
  const values = new Map<string, string>();
  const add = (name: string, version: string) => {
    if (!/^(@[\w.-]+\/)?[\w.-]+$/.test(name) || !EXACT_VERSION.test(version)) {
      throw new OpenCodeConfigValidationError([`package '${name}' must use an exact version`]);
    }
    if (values.has(name) && values.get(name) !== version) {
      throw new OpenCodeConfigValidationError([
        `package '${name}' has conflicting pinned versions`,
      ]);
    }
    values.set(name, version);
  };
  for (const item of packages) add(item.name, item.version);
  for (const plugin of plugins) {
    const reference = parsePackageReference(plugin.name);
    add(reference.name, plugin.version);
    if (reference.version !== undefined && reference.version !== plugin.version) {
      throw new OpenCodeConfigValidationError([
        `plugin '${plugin.name}' has conflicting pinned versions`,
      ]);
    }
  }
  for (const provider of providers) {
    const spec = provider.package;
    if (spec === undefined || BUNDLED.has(spec)) continue;
    if (!spec.startsWith("aisdk:")) {
      throw new OpenCodeConfigValidationError([
        `provider.${provider.id}.package must use a supported native runtime or aisdk: package`,
      ]);
    }
    const reference = parsePackageReference(spec.slice(6));
    if (reference.version !== undefined) add(reference.name, reference.version);
  }
  return {
    lockfileVersion: OPENCODE_PACKAGE_LOCK_VERSION,
    packages: Object.fromEntries([...values].sort(([a], [b]) => a.localeCompare(b))),
  };
}

export function pinPackageReference(
  rawSpec: string,
  lock: OpenCodePackageLock,
  path: string,
): string {
  const parsed = parsePackageReference(rawSpec);
  const pinned = lock.packages[parsed.name];
  if (pinned === undefined) {
    throw new OpenCodeConfigValidationError([
      `package '${parsed.name}' is not declared with an exact version for ${path}`,
    ]);
  }
  if (parsed.version !== undefined && parsed.version !== pinned) {
    throw new OpenCodeConfigValidationError([`${path} has conflicting pinned versions`]);
  }
  return `${parsed.name}@${pinned}`;
}

export function renderProviderPackage(
  spec: string,
  lock: OpenCodePackageLock,
  path: string,
): string {
  if (BUNDLED.has(spec)) return spec;
  if (!spec.startsWith("aisdk:")) {
    throw new OpenCodeConfigValidationError([
      `${path} must use a supported native runtime or aisdk: package`,
    ]);
  }
  return `aisdk:${pinPackageReference(spec.slice(6), lock, path)}`;
}

function parsePackageReference(spec: string): { name: string; version?: string } {
  const match = /^((?:@[\w.-]+\/)?[\w.-]+)(?:@(.+))?$/.exec(spec);
  if (!match || (match[2] !== undefined && !EXACT_VERSION.test(match[2]))) {
    throw new OpenCodeConfigValidationError([
      `'${spec}' must use a declared npm package with an exact version`,
    ]);
  }
  return { name: match[1], ...(match[2] === undefined ? {} : { version: match[2] }) };
}
