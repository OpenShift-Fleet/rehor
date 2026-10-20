import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { renderOpenCodePolicyPlugin } from "../src/runtimes/opencode-v1/policy-plugin";

type Action = "allow" | "ask" | "deny";
type Permission = Action | Record<string, Action | Record<string, Action>>;
type Agent = { permission?: Permission };
type PolicyCase = { name: string; permission?: Permission; private: Action; public: Action };
type Hooks = {
  config(config: { agent: Record<string, Agent> }): Promise<void>;
  "shell.env"(input: object, output: { env: Record<string, string> }): Promise<void>;
};

async function withPolicy(run: (hooks: Hooks) => Promise<void>, roots = ["/tmp/opencode"]) {
  const directory = await mkdtemp(join(tmpdir(), "opencode-policy-"));
  try {
    const path = join(directory, "policy.mjs");
    const boundary: Record<string, Action> = { "*": "deny" };
    for (const root of roots) boundary[`${root}/*`] = "allow";
    await writeFile(
      path,
      renderOpenCodePolicyPlugin('/shell/"config', roots.length > 0 ? boundary : "deny"),
    );
    const plugin = await import(/* @vite-ignore */ pathToFileURL(path).href);
    await run(await plugin.default());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// Independent native-style regex oracle: no derivative/clipping logic.
function matches(pattern: string, value: string, expandHome = false): boolean {
  if (expandHome) {
    if (pattern === "~" || pattern.startsWith("~/")) pattern = homedir() + pattern.slice(1);
    else if (pattern.startsWith("$HOME")) pattern = homedir() + pattern.slice(5);
  }
  const source = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("*", ".*")
    .replaceAll("?", ".")
    .replace(/ \.(\*)$/, "( .*)?");
  return new RegExp(`^${source}$`, "s").test(value);
}

function evaluate(permission: Permission | undefined, name: string, path: string): Action {
  let result: Action = "deny";
  const tools = typeof permission === "string" ? { "*": permission } : (permission ?? {});
  for (const [pattern, action] of Object.entries(tools)) {
    if (!matches(pattern, name)) continue;
    const paths = typeof action === "string" ? { "*": action } : action;
    for (const [glob, value] of Object.entries(paths)) {
      if (matches(glob, path, true)) result = value;
    }
  }
  return result;
}

const cases: PolicyCase[] = [
  { name: "inherits deployment grants", private: "allow", public: "allow" },
  {
    name: "deny-except retains later exception",
    permission: { external_directory: { "*": "deny", "/tmp/opencode/public/*": "allow" } },
    private: "deny",
    public: "allow",
  },
  {
    name: "native explore shape overrides wildcard deny",
    permission: { "*": "deny", read: "allow", external_directory: { "/tmp/opencode/*": "allow" } },
    private: "allow",
    public: "allow",
  },
  ...(["allow", "deny", "ask"] as const).flatMap((action) => [
    { name: `permission scalar ${action}`, permission: action, private: action, public: action },
    {
      name: `external scalar ${action}`,
      permission: { external_directory: action },
      private: action,
      public: action,
    },
    {
      name: `external object ${action}`,
      permission: { external_directory: { "*": action } },
      private: action,
      public: action,
    },
  ]),
  {
    name: "later broad allow overrides earlier narrow ask",
    permission: { external_directory: { "/tmp/opencode/private/*": "ask", "*": "allow" } },
    private: "allow",
    public: "allow",
  },
  {
    name: "later broad allow overrides earlier narrow deny",
    permission: { external_directory: { "/tmp/opencode/private/*": "deny", "*": "allow" } },
    private: "allow",
    public: "allow",
  },
  ...(["ask", "deny"] as const).map<PolicyCase>((action) => ({
    name: `later narrow ${action} overrides broad allow`,
    permission: { external_directory: { "*": "allow", "/tmp/opencode/private/*": action } },
    private: action,
    public: "allow" as const,
  })),
  {
    name: "wildcard tool before explicit tool",
    permission: { "external_?irectory": "ask", external_directory: "allow" },
    private: "allow",
    public: "allow",
  },
  {
    name: "wildcard tool after explicit tool",
    permission: { external_directory: "allow", "external_?irectory": "ask" },
    private: "ask",
    public: "ask",
  },
  {
    name: "broad tool wildcard after explicit tool",
    permission: { external_directory: "allow", "*": "deny" },
    private: "deny",
    public: "deny",
  },
  {
    name: "star before root retains restriction",
    permission: { external_directory: { "/tmp/*/private/*": "ask" } },
    private: "ask",
    public: "allow",
  },
  {
    name: "question mark before root retains restriction",
    permission: { external_directory: { "/tmp/openc?de/private/*": "deny" } },
    private: "deny",
    public: "allow",
  },
  {
    name: "overlapping broad glob reopens earlier restriction",
    permission: { external_directory: { "*/private/*": "deny", "/t*/openc?de/*": "allow" } },
    private: "allow",
    public: "allow",
  },
  {
    name: "duplicate clipped path is reinserted after narrow restriction",
    permission: {
      external_directory: {
        "/tmp/opencode/*": "deny",
        "/tmp/opencode/private/*": "ask",
        "*": "allow",
      },
    },
    private: "allow",
    public: "allow",
  },
  {
    name: "normalizes backslashes",
    permission: { external_directory: { "\\tmp\\opencode\\private\\*": "ask" } },
    private: "ask",
    public: "allow",
  },
  {
    name: "optional space-star tool suffix matches bare tool name",
    permission: { "external_directory *": "ask" },
    private: "ask",
    public: "ask",
  },
];

it.each(cases)("$name", async (test) => {
  await withPolicy(async (hooks) => {
    const agent: Agent = { permission: test.permission };
    await hooks.config({ agent: { test: agent } });
    expect(evaluate(agent.permission, "external_directory", "/tmp/opencode/private/file")).toBe(
      test.private,
    );
    expect(evaluate(agent.permission, "external_directory", "/tmp/opencode/public/file")).toBe(
      test.public,
    );
    for (const outside of ["/", "/tmp/*", "/tmp/opencode-sibling/file", "/home/other/file"]) {
      expect(evaluate(agent.permission, "external_directory", outside), outside).toBe("deny");
    }
    expect(Object.keys(agent.permission ?? {}).at(-1)).toBe("external_directory");
  });
});

it("preserves other tool permissions and shell config exactly", async () => {
  await withPolicy(async (hooks) => {
    const other = {
      "*": "ask",
      read: { "*": "allow", "*.env": "deny" },
      edit: "deny",
      bash: "ask",
    } as const;
    const agent: Agent = { permission: { external_directory: "allow", ...other } };
    await hooks.config({ agent: { test: agent } });
    expect(agent.permission).toMatchObject(other);
    expect(Object.entries(agent.permission ?? {}).slice(0, -1)).toEqual(Object.entries(other));
    expect(evaluate(agent.permission, "read", "/tmp/opencode/credential.env")).toBe("deny");
    expect(evaluate(agent.permission, "read", "/tmp/opencode/public.txt")).toBe("allow");
    expect(evaluate(agent.permission, "edit", "/tmp/opencode/public.txt")).toBe("deny");
    expect(evaluate(agent.permission, "bash", "pwd")).toBe("ask");
    const output = { env: {} };
    await hooks["shell.env"]({}, output);
    expect(output.env).toEqual({ XDG_CONFIG_HOME: '/shell/"config' });
  });
});

it("denies all external paths without deployment roots", async () => {
  await withPolicy(async (hooks) => {
    const agents: Record<string, Agent> = {
      widened: { permission: "allow" },
      scoped: { permission: { external_directory: { "/tmp/*": "allow" } } },
      asked: { permission: "ask" },
    };
    await hooks.config({ agent: agents });
    for (const agent of Object.values(agents)) {
      expect(evaluate(agent.permission, "external_directory", "/tmp/opencode/file")).toBe("deny");
    }
  }, []);
});

it("preserves ordered outcomes across overlapping roots and wildcard derivatives", async () => {
  const permission: Permission = {
    external_directory: {
      "*": "deny",
      "*/openc?de/*": "allow",
      "*/private/*": "ask",
      "*private/public/*": "allow",
    },
  };
  await withPolicy(
    async (hooks) => {
      const agent: Agent = { permission };
      await hooks.config({ agent: { test: agent } });
      for (const suffix of [
        "file",
        "private/file",
        "private/public/file",
        "private/private/file",
      ]) {
        const path = `/tmp/opencode/${suffix}`;
        expect(evaluate(agent.permission, "external_directory", path), path).toBe(
          evaluate(permission, "external_directory", path),
        );
      }
      expect(evaluate(agent.permission, "external_directory", "/tmp/other/file")).toBe("deny");
    },
    ["/tmp/opencode", "/tmp/opencode/private"],
  );
});

it.each(["~/opencode/*", "$HOME/opencode/*", "$HOME/opencode *"])(
  "expands native home reference %s and optional path suffix",
  async (pattern) => {
    await withPolicy(
      async (hooks) => {
        const permission: Permission = { external_directory: { [pattern]: "ask" } };
        const agent: Agent = { permission };
        await hooks.config({ agent: { test: agent } });
        for (const path of [
          `${homedir()}/opencode/file`,
          `${homedir()}/opencode`,
          `${homedir()}/opencode suffix`,
        ]) {
          const expected =
            path.startsWith(`${homedir()}/`) && matches(pattern, path, true) ? "ask" : "allow";
          expect(evaluate(agent.permission, "external_directory", path), path).toBe(expected);
        }
        expect(evaluate(agent.permission, "external_directory", `${homedir()}-sibling/file`)).toBe(
          "deny",
        );
      },
      [homedir()],
    );
  },
);

it("uses UTF-16 code units when deriving globs through Unicode roots", async () => {
  const root = "/tmp/🦕";
  await withPolicy(
    async (hooks) => {
      const agent: Agent = {
        permission: { external_directory: { "/tmp/??/*": "ask", "/tmp/?/*": "deny" } },
      };
      await hooks.config({ agent: { test: agent } });
      expect(evaluate(agent.permission, "external_directory", `${root}/file`)).toBe("ask");
      expect(evaluate(agent.permission, "external_directory", "/tmp/🦖/file")).toBe("deny");
    },
    [root],
  );
});

it("root/* covers native requests for the root directory itself", async () => {
  await withPolicy(async (hooks) => {
    const agent: Agent = {};
    await hooks.config({ agent: { test: agent } });
    expect(evaluate(agent.permission, "external_directory", "/tmp/opencode/*")).toBe("allow");
    expect(evaluate(agent.permission, "external_directory", "/tmp/opencode-sibling/*")).toBe(
      "deny",
    );
  });
});
