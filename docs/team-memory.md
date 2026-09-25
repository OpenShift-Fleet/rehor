# Team Memory (read-only MCP)

Shared vector memory from the bot's learnings, review feedback, and codebase patterns — available to any MCP-compatible client.

The public endpoint exposes **only** `memory_search` and `memory_list`. Write tools (`memory_store`, `memory_delete`, `task_*`, `bot_status_update`, Slack, etc.) stay on the internal bot MCP (`:8080`) and are not reachable from the Route.

## Connect an MCP client

Add to your project's `.mcp.json` (or your client's MCP settings):

```json
{
  "mcpServers": {
    "team-memory": {
      "type": "http",
      "url": "https://<TEAM_MEMORY_URL>/mcp",
      "headers": {
        "Authorization": "Bearer <MEMORY_API_KEY>"
      }
    }
  }
}
```

| Placeholder | Source |
|-------------|--------|
| `MEMORY_API_KEY` | Bearer token stored in Vault under the deployment's secrets (field `team-memory-api-key`); the exact Vault path varies by deployment. Local compose default: `local-dev-memory-key` |

**Local compose** (after `make memory-server`):

```json
{
  "mcpServers": {
    "team-memory": {
      "type": "http",
      "url": "http://localhost:8081/mcp",
      "headers": {
        "Authorization": "Bearer local-dev-memory-key"
      }
    }
  }
}
```

Transport is **streamable HTTP** at `/mcp` (same as the bot MCP). Works with any MCP-compatible client.

Do **not** point human sessions at the internal bot endpoint (`http://devbot-memory-server:8080/mcp` or `http://localhost:8080/mcp`) — that surface includes write/task tools.

## Automatic usage via CLAUDE.md

Connecting the MCP server only registers the tools. The client will **not** search memory unless instructed. Add a section to each repo's `CLAUDE.md`.

### Common preamble (all repo types)

```markdown
## Team Memory

This project is connected to the team's shared memory via the `team-memory` MCP server.
Before implementing changes:
- Search team-memory for relevant learnings and review feedback for this repo
- Check for known patterns, past mistakes, and reviewer preferences
- Apply any insights found to avoid repeating past corrections

Categories: `learning`, `review_feedback`, `codebase_pattern`.
```

### Frontend repos

```markdown
## Team Memory

This project is connected to the team's shared memory via the `team-memory` MCP server.
Before implementing UI changes:
- Search for PatternFly / CSS / accessibility review feedback for this repo
- Look up known codebase patterns (tables, forms, navigation, Chrome bindings)
- Apply reviewer preferences so the same comments are not repeated

Examples:
- `memory_search(query="PatternFly table pagination", repo="insights-chrome", category="review_feedback")`
- `memory_search(query="useChrome navigation", repo="insights-chrome", category="codebase_pattern")`
- `memory_list(repo="insights-chrome", category="review_feedback", limit=10)`
```

### Backend repos

```markdown
## Team Memory

This project is connected to the team's shared memory via the `team-memory` MCP server.
Before implementing API or service changes:
- Search learnings and review feedback for this repo (error handling, auth, migrations)
- Check CI and testing patterns tagged `ci`, `api`, or `testing`
- Apply known pitfalls before opening a PR

Examples:
- `memory_search(query="transaction rollback error handling", repo="my-service", category="learning")`
- `memory_search(query="integration test fixtures", repo="my-service", tag="testing")`
- `memory_list(repo="my-service", tag="ci", limit=10)`
```

### Config / infra repos

```markdown
## Team Memory

This project is connected to the team's shared memory via the `team-memory` MCP server.
Before changing deploy, CI, or cluster config:
- Search for past OpenShift / CI / secrets mistakes for this repo
- Prefer patterns already validated in review (`learning`, tags `openshift`, `ci`)
- Confirm similar changes did not cause rollout or permission issues

Examples:
- `memory_search(query="NetworkPolicy ingress route", repo="platform-frontend-ai-dev", tag="openshift")`
- `memory_search(query="Tekton pipeline failure", category="learning", tag="ci")`
- `memory_list(category="learning", tag="openshift", limit=10)`
```

## Operators

- **Full bot MCP** (`:8080`): ClusterIP only; NetworkPolicy allows bot pods. No Bearer auth (trusted network).
- **Read-only team MCP** (`:8081`): OpenShift Route `devbot-team-memory`; requires `MEMORY_API_KEY`.
- Vault: add `team-memory-api-key` to `devbot-secrets` before deploying.
- Template parameter: `TEAM_MEMORY_URL` (Route hostname).
