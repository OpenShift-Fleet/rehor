export const OPEN_CODE_AGENTS_FILE = "AGENTS.md" as const;

export const OPEN_CODE_RESOURCE_DIRECTORIES = [
  "agents",
  "commands",
  "instructions",
  "rules",
  "plugins",
  "skills",
  "themes",
] as const;

export const OPEN_CODE_RESOURCE_DIRECTORY_SET: ReadonlySet<string> = new Set(
  OPEN_CODE_RESOURCE_DIRECTORIES,
);

export const OPEN_CODE_INSTANCE_SETTING_KEYS: ReadonlySet<string> = new Set([
  "agents",
  "commands",
  "compaction",
  "default_agent",
  "experimental",
  "formatter",
  "instructions",
  "mcp",
  "permissions",
  "plugins",
  "snapshots",
  "watcher",
]);

// V2 built-ins manage sessions/worktrees outside the coordinator's lifecycle.
// Native MCP exposure follows each server's codemode option; these management
// integrations stay disabled independently of the execute wrapper permission.
export const OPEN_CODE_MANAGEMENT_PLUGIN_REMOVALS = [
  "-opencode.tools",
  "-opencode.tools.mcp-resources",
] as const;
