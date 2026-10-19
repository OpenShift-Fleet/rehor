export const OPEN_CODE_AGENTS_FILE = "AGENTS.md" as const;

export const OPEN_CODE_RESOURCE_DIRECTORIES = [
  "agents",
  "agent",
  "commands",
  "command",
  "instructions",
  "rules",
  "modes",
  "mode",
  "plugins",
  "plugin",
  "skills",
  "skill",
  "tools",
  "tool",
  "themes",
  "theme",
] as const;

export const OPEN_CODE_RESOURCE_DIRECTORY_SET: ReadonlySet<string> = new Set(
  OPEN_CODE_RESOURCE_DIRECTORIES,
);

export const OPEN_CODE_INSTANCE_SETTING_KEYS: ReadonlySet<string> = new Set([
  "agent",
  "command",
  "compaction",
  "default_agent",
  "disabled_providers",
  "formatter",
  "instructions",
  "mcp",
  "permission",
  "plugin",
  "snapshot",
  "subagent_depth",
  "tools",
  "watcher",
]);
