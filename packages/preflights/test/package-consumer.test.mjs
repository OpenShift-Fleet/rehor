import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

/**
 * Genuine external-consumer smoke test: a scratch package outside this
 * repository links `@rehor/preflights` by name (a node_modules symlink, the
 * same way the workspace links it) and must be able to (a) import the
 * compiled runtime entrypoints by package name, (b) typecheck strictly
 * against the emitted declarations under NodeNext, and (c) be refused on
 * deep `dist/` paths the exports map does not declare. All fixtures live in
 * a temporary directory so nothing pollutes the source tree's build output.
 */

const consumerRuntime = `
import { createPopulatedRegistry } from "@rehor/preflights/preflights";
import { requiredInputNames, validateConfig } from "@rehor/preflights";

const registry = createPopulatedRegistry();
const valid = validateConfig(["jira-triage"], registry);
if (!valid.ok || valid.entries.length !== 1 || valid.entries[0].id !== "jira-triage") {
  throw new Error("consumer: jira-triage shorthand entry should validate");
}
const invalid = validateConfig(["jira-sprint"], registry);
if (invalid.ok || invalid.invalid[0].id !== "jira-sprint") {
  throw new Error("consumer: jira-sprint without label should fail closed");
}
if (requiredInputNames(registry.get("jira-sprint").input).join(",") !== "label") {
  throw new Error("consumer: requiredInputNames should report label for jira-sprint");
}
try {
  await import("@rehor/preflights/dist/core/validate.js");
  throw new Error("consumer: deep dist import must be refused by the exports map");
} catch (error) {
  if (error?.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error;
}
console.log("consumer-runtime-ok");
`;

const consumerTypes = `
import { createPopulatedRegistry } from "@rehor/preflights/preflights";
import {
  requiredInputNames,
  validateConfig,
  type ConfigValidationResult,
  type PreflightRegistry,
  type ResolvedPreflightEntry,
} from "@rehor/preflights";

const registry: PreflightRegistry = createPopulatedRegistry();
const result: ConfigValidationResult = validateConfig(["jira-triage"], registry);
const entries: readonly ResolvedPreflightEntry[] = result.ok ? result.entries : [];
if (entries.length !== 1 || entries[0].id !== "jira-triage") {
  throw new Error("consumer typecheck fixture: expected the jira-triage entry");
}
const required: readonly string[] = requiredInputNames(registry.get("jira-sprint")!.input);
if (required[0] !== "label") {
  throw new Error("consumer typecheck fixture: expected label to be required");
}
// @ts-expect-error the second argument must be a registry, not a number
validateConfig([], 42);
`;

test("an external consumer imports the package by name and typechecks against its declarations", () => {
  assert.ok(
    existsSync(join(packageRoot, "dist", "index.js")),
    "dist/index.js is missing; run npm run build first",
  );
  const consumerRoot = mkdtempSync(join(tmpdir(), "rehor-preflights-consumer-"));
  try {
    writeFileSync(
      join(consumerRoot, "package.json"),
      JSON.stringify(
        {
          name: "rehor-preflights-consumer",
          private: true,
          type: "module",
          dependencies: { "@rehor/preflights": "0.0.0" },
        },
        null,
        2,
      ),
    );
    mkdirSync(join(consumerRoot, "node_modules", "@rehor"), { recursive: true });
    symlinkSync(packageRoot, join(consumerRoot, "node_modules", "@rehor", "preflights"), "dir");
    writeFileSync(join(consumerRoot, "consumer.mjs"), consumerRuntime);
    writeFileSync(join(consumerRoot, "consumer.ts"), consumerTypes);
    writeFileSync(
      join(consumerRoot, "tsconfig.json"),
      JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            strict: true,
            noEmit: true,
            forceConsistentCasingInFileNames: true,
            skipLibCheck: false,
            types: [],
          },
          include: ["consumer.ts"],
        },
        null,
        2,
      ),
    );

    const runtime = spawnSync(process.execPath, [join(consumerRoot, "consumer.mjs")], {
      encoding: "utf8",
    });
    assert.equal(
      runtime.status,
      0,
      `runtime import by package name failed:\n${runtime.stderr}${runtime.stdout}`,
    );
    assert.match(runtime.stdout, /consumer-runtime-ok/);

    const tsc = join(dirname(require.resolve("typescript/package.json")), "bin", "tsc");
    const typecheck = spawnSync(
      process.execPath,
      [tsc, "-p", join(consumerRoot, "tsconfig.json")],
      {
        encoding: "utf8",
      },
    );
    assert.equal(
      typecheck.status,
      0,
      `strict NodeNext typecheck against the package declarations failed:\n${typecheck.stdout}${typecheck.stderr}`,
    );
  } finally {
    rmSync(consumerRoot, { recursive: true, force: true });
  }
});
