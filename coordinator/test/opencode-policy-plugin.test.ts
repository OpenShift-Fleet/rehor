import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { renderOpenCodePolicyPlugin } from "../src/runtimes/opencode-v1/policy-plugin";

it("clamps native JSON/Markdown agent grants, retaining agent denies and credential read rules", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-policy-"));
  try {
    const path = join(directory, "policy.mjs");
    await writeFile(
      path,
      renderOpenCodePolicyPlugin('/shell/"config', {
        "*": "deny",
        "/tmp/opencode": "allow",
        "/tmp/opencode/*": "allow",
      }),
    );
    const plugin = await import(/* @vite-ignore */ pathToFileURL(path).href);
    const hooks = await plugin.default();
    const config = {
      agent: {
        inherited: {},
        widened: {
          permission: {
            "*": "allow",
            external_directory: "allow",
            read: { "*.env": "deny" },
            edit: "deny",
          },
        },
        restricted: {
          permission: { external_directory: { "/tmp/opencode/private/*": "deny" }, bash: "deny" },
        },
        denied: { permission: { external_directory: "deny" } },
        wildcardDenied: { permission: { "external_?irectory": "deny" } },
      },
    };
    await hooks.config(config);
    const agents = config.agent as unknown as Record<
      string,
      { permission: Record<string, unknown> }
    >;
    for (const name of ["inherited", "widened"]) {
      expect(agents[name].permission.external_directory).toEqual({
        "*": "deny",
        "/tmp/opencode": "allow",
        "/tmp/opencode/*": "allow",
      });
      expect(Object.keys(agents[name].permission).at(-1)).toBe("external_directory");
    }
    expect(agents.widened.permission).toMatchObject({ read: { "*.env": "deny" }, edit: "deny" });
    expect(agents.restricted.permission).toMatchObject({
      bash: "deny",
      external_directory: { "/tmp/opencode/private/*": "deny" },
    });
    for (const name of ["denied", "wildcardDenied"]) {
      const rules = agents[name].permission.external_directory as Record<string, string>;
      expect(Object.entries(rules).at(-1)).toEqual(["*", "deny"]);
    }
    const output = { env: {} };
    await hooks["shell.env"]({}, output);
    expect(output.env).toEqual({ XDG_CONFIG_HOME: '/shell/"config' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("keeps native agent grants fail-closed when deployment directories are absent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "opencode-policy-closed-"));
  try {
    const path = join(directory, "policy.mjs");
    await writeFile(path, renderOpenCodePolicyPlugin(undefined, "deny"));
    const plugin = await import(/* @vite-ignore */ pathToFileURL(path).href);
    const hooks = await plugin.default();
    const config = {
      agent: {
        widened: { permission: "allow" },
        scoped: { permission: { external_directory: { "/tmp/*": "allow" } } },
      },
    };
    await hooks.config(config);
    for (const agent of Object.values(config.agent)) {
      expect(agent.permission).toMatchObject({ external_directory: { "*": "deny" } });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
