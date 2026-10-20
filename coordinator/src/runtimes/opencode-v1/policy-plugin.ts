import { stableJson } from "../shared";

/** Runs after native JSON/Markdown agent loading, before native agent permission merging. */
export function renderOpenCodePolicyPlugin(
  configHome: string | undefined,
  externalDirectory: unknown,
): string {
  return `export default async () => ({
  "shell.env": async (_, output) => { output.env.XDG_CONFIG_HOME = ${JSON.stringify(configHome ?? "")}; },
  config: async (config) => {
    const boundary = ${stableJson(externalDirectory ?? "deny")};
    const rules = typeof boundary === "string" ? { "*": boundary } : boundary;
    for (const agent of Object.values(config.agent ?? {})) {
      const permission = typeof agent.permission === "string" ? { "*": agent.permission } : (agent.permission ?? {});
      const denies = {};
      for (const [name, action] of Object.entries(permission)) {
        const pattern = name.split("").map((c) => c === "*" ? ".*" : c === "?" ? "." : "\\\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")).join("");
        if (!new RegExp("^" + pattern + "$", "s").test("external_directory")) continue;
        if (action === "deny") denies["*"] = "deny";
        else if (action && typeof action === "object") {
          for (const [path, value] of Object.entries(action)) if (value === "deny") denies[path] = "deny";
        }
      }
      // Reinsert last: agent-wide wildcard grants cannot override this boundary.
      const { external_directory: _, ...other } = permission;
      const external = { ...rules };
      for (const [path, action] of Object.entries(denies)) {
        delete external[path];
        external[path] = action;
      }
      agent.permission = { ...other, external_directory: external };
    }
  }
});
`;
}
