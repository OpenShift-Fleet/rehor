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
// Keep V2.1.2's other built-ins intentionally: opencode.config.* applies provider,
// agent, instruction, MCP and policy config; opencode.tool.* supplies read/edit/
// write/shell/skill/subagent and other permission-gated tools. Provider adapters,
// Code Mode defaults, VCS, compaction and prompt plugins are runtime plumbing.
// `-*` would remove required adapters, not restore V1's default-plugin guard.
// See upstream packages/core/src/plugin/internal.ts and the migration guide for
// retained integrations and independent permission/provider/egress controls.
export const OPEN_CODE_MANAGEMENT_PLUGIN_REMOVALS = [
  "-opencode.tools",
  "-opencode.tools.mcp-resources",
] as const;
