# Rehor Impact Collection

Read-only collection from Jira, Rehor memory API, GitHub, GitLab CEE, and local app-interface configuration.

## Setup

Create local `.env.report`. Required secret variables:

```text
JIRA_EMAIL
JIRA_TOKEN
GH_BOT_CLI_TOKEN
GL_BOT_CLI_TOKEN
```

Optional variables:

```text
REHOR_MEMORY_API
REHOR_CONFIG_REPOS_DIR
JIRA_FILTER_ID
GH_AUTHORS
GL_AUTHOR_ID
GITLAB_HOST
```

For live memory API access, use short-lived tokens generated from a local OpenShift context:

```text
REHOR_MEMORY_SERVICE_ACCOUNT=devbot-memory-server
REHOR_MEMORY_SERVICE_ACCOUNT_NAMESPACE=platform-frontend-ai-dev-stage
REHOR_MEMORY_TOKEN_DURATION=1h
```

The collector runs `oc create token` for each invocation. `REHOR_MEMORY_TOKEN` remains supported as a direct-token override, but long-lived tokens should not be stored.

`.env.report` is gitignored. Never put tokens in source, reports, or raw exports.

## Run

Run complete collection, task-artifact analysis, config-repository cloning, and Markdown generation:

```bash
python3 impact-data/run_rehor_impact.py
```

Skip expensive cycle-run history while iterating:

```bash
python3 impact-data/run_rehor_impact.py --skip-cycles
```

Prevent config repository cloning:

```bash
python3 impact-data/run_rehor_impact.py --no-clone-config-repos
```

## Outputs

Each run is written to `impact-data/runs/<UTC-run-id>/`:

- `report.md`: Jinja-rendered report
- `task-references.csv`: task artifacts mapped to Jira keys and PRs/MRs
- `reconciliation.json`: deduplicated observed work identities and coverage gaps
- `jira.json`: Jira filter snapshot
- `memory.json`: tasks, instances, costs, analytics, and optional cycle runs
- `git-activity.json`: authenticated bot identities and Git activity
- `app-interface.json`: deployment/configuration inventory and clone results

Generated outputs are ignored by Git. Report counts distinguish observed work from unrecoverable local pre-deployment activity.

## Template

Markdown layout lives in `impact-data/report.md.j2`. Python prepares structured context; Jinja2 renders variables and tables.

Regenerate a report without recollecting data:

```bash
python3 impact-data/generate_rehor_report.py impact-data/runs/<UTC-run-id>
```

Audit task-referenced Jira keys missing from filter:

```bash
python3 impact-data/audit_jira_filter_coverage.py
```
