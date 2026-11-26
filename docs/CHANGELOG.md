# Changelog

## Unreleased

- Workflow and env-preset `requires.env_vars`/`optional_env_vars` plus profile
  `env`/`sandbox.env` declarations now forward to the OpenCode child: ordinary
  declared names copy from the runner environment when present, profile `env`
  literals apply only as a fallback behind deployment-provided values,
  `sandbox.env` values forward only on dispatched sandbox runs, and a declared
  name that is invalid or protected as a platform runtime, loader, or security
  control fails the cycle instead of being silently dropped. The whole ambient
  environment is never forwarded.
- Remote MCP definitions with environment references outside the approved
  `JIRA_MCP_URL` URL reference are rejected during config merging for both the
  legacy Claude and OpenCode paths; headers and local MCP environments cannot
  carry environment references.
