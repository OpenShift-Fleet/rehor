/** Runs after native JSON/Markdown agent loading, before native agent permission merging. */
export function renderOpenCodePolicyPlugin(
  configHome: string | undefined,
  externalDirectory: unknown,
): string {
  return `import { homedir } from "node:os";

// Native wildcards use UTF-16 regex characters, including slashes and newlines.
const variants = (pattern) => pattern.endsWith(" *") ? [pattern, pattern.slice(0, -2)] : [pattern];
const normalize = (pattern) => pattern.replaceAll("\\\\", "/");
const expand = (pattern) => normalize(pattern === "~" || pattern.startsWith("~/")
  ? homedir() + pattern.slice(1)
  : pattern.startsWith("$HOME") ? homedir() + pattern.slice(5) : pattern);
const matchesName = (pattern) => variants(normalize(pattern)).some((variant) => {
  const source = variant.split("").map((c) => c === "*" ? ".*" : c === "?" ? "." : "\\\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")).join("");
  return new RegExp("^" + source + "$", "s").test("external_directory");
});

// Derive the glob after consuming a literal root prefix. Every surviving NFA
// state contributes one suffix; their union is the exact boundary intersection.
const clip = (pattern, prefix) => {
  const closure = (states) => {
    const result = new Set(states);
    for (const index of result) if (pattern[index] === "*") result.add(index + 1);
    return result;
  };
  let states = closure([0]);
  for (let offset = 0; offset < prefix.length; offset++) {
    const next = new Set();
    for (const index of states) {
      const token = pattern[index];
      if (token === "*") next.add(index);
      else if (token === "?" || token === prefix[offset]) next.add(index + 1);
    }
    states = closure(next);
    if (states.size === 0) break;
  }
  return Array.from(states, (index) => prefix + pattern.slice(index));
};

export default async () => ({
  "shell.env": async (_, output) => { output.env.XDG_CONFIG_HOME = ${JSON.stringify(configHome ?? "")}; },
  config: async (config) => {
    const boundary = ${JSON.stringify(externalDirectory ?? "deny")};
    const rules = typeof boundary === "string" ? { "*": boundary } : boundary;
    const roots = Object.entries(rules).filter(([path, action]) => action === "allow" && path.endsWith("/*")).map(([path]) => path.slice(0, -1));
    for (const agent of Object.values(config.agent ?? {})) {
      const permission = typeof agent.permission === "string" ? { "*": agent.permission } : (agent.permission ?? {});
      const external = { ...rules };
      for (const [name, action] of Object.entries(permission)) {
        if (!matchesName(name)) continue;
        const paths = typeof action === "string" ? { "*": action } : (action ?? {});
        for (const [path, value] of Object.entries(paths)) {
          for (const pattern of variants(expand(path))) {
            for (const root of roots) {
              for (const clipped of clip(pattern, root)) {
                // Native rules are last-match-wins, even when a path repeats.
                delete external[clipped];
                external[clipped] = value;
              }
            }
          }
        }
      }
      // Reinsert last: agent-wide wildcard grants cannot override this boundary.
      const { external_directory: _, ...other } = permission;
      agent.permission = { ...other, external_directory: external };
    }
  }
});
`;
}
