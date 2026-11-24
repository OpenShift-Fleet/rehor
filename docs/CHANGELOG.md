# Changelog

## Unreleased

- Remote MCP definitions with environment references outside the approved
  `JIRA_MCP_URL` URL reference are rejected during config merging for both the
  legacy Claude and OpenCode paths; headers and local MCP environments cannot
  carry environment references.
