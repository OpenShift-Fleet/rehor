# Dev Bot (Rehor)

## What

Rehor is an autonomous developer agent that picks groomed Jira tickets, implements code changes in target repos, opens PRs/MRs, and maintains them through CI and review cycles. It runs as a polling loop using the Claude Agent SDK, integrating with Jira Cloud, GitHub, GitLab, and a persistent memory system backed by PostgreSQL.

The bot operates in cycles. Each cycle, lightweight Python preflight scripts check external systems (GitHub PRs, GitLab MRs, Jira sprint) for actionable work. An AI session only starts when there's something to do, so the common "nothing changed" case costs zero tokens.

## Why

- **Hands-free ticket implementation** — groomed tickets get picked up, implemented, and PRed without human intervention
- **Consistent quality** — every PR follows the same patterns: persona-specific coding standards, test verification, visual checks for UI changes
- **Scales across repos** — one bot instance handles multiple repos via label-based routing and fork-based PRs
- **Learns from past work** — completed work is stored as RAG memories, so the bot improves over time
- **Cost-efficient** — preflight scripts filter out "nothing to do" cycles before any AI tokens are spent

## How

1. **Configure your instance** — select a workflow and env presets using the [Presets Overview](presets/README.md)
2. **Label tickets** — add your bot's primary label and a `repo:<name>` label to groomed Jira tickets
3. **Preflight scripts gather data** — each cycle, Python scripts check GitHub PRs, GitLab MRs, and Jira for actionable changes
4. **AI session runs only when needed** — if any preflight script returns "start", Claude receives all gathered data and acts on it
5. **PR lifecycle is automatic** — the bot handles CI failures, review feedback, merge conflicts, and post-merge cleanup

For the full cycle diagram and state machine, see [Bot Workflow Loop](bot-workflow-loop.md).

```
Ticket groomed + labeled
    → Bot claims ticket (In Progress)
        → Bot implements on branch bot/KEY
            → PR opened (Code Review)
                → CI fix / review feedback loop
                    → PR merged (Done, learnings stored)
```

## Example

A real ticket: RHCLOUD-37254 ("RBAC allowing roles with same name as System Roles").

1. A human groomed the ticket and added labels `hcc-ai-platform-accessmanagement` and `repo:insights-rbac`
2. The bot found it via JQL, assigned itself, transitioned to "In Progress", added it to the active sprint
3. It cloned `insights-rbac`, created branch `bot/RHCLOUD-37254`, loaded the `rbac` persona, read the repo's `CLAUDE.md`, and implemented the fix
4. It pushed the branch, opened a PR via `gh pr create`, transitioned the ticket to "Code Review", and commented on Jira with the PR link
5. A human reviewed the PR. Each cycle, the bot checked for new feedback and addressed comments
6. Once merged, the bot transitioned the ticket to "Done" and stored learnings in RAG memory

For more examples (cross-repo features, CVE triage, UI changes with screenshots), see the [Operations Guide](https://github.com/RedHatInsights/platform-frontend-ai-dev/blob/master/OPERATIONS.md#what-the-bot-has-done).

## Common Mistakes

**Wrong NetworkPolicy proxy label.** The proxy pod's label is `app.kubernetes.io/name: devbot-proxy`, not `proxy`. Using the wrong label silently blocks all bot egress. The bot will start but hang forever waiting for the executor connection. See [Onboarding](onboarding-new-instance.md#gotchas) for details.

**DNS port is 5353, not 53.** OpenShift uses a custom DNS server on port 5353 in the `openshift-dns` namespace. Standard port 53 or `kube-dns` selectors cause pods to hang on name resolution.

**Missing `ScaledObject.keda.sh` in managedResourceTypes.** Without this, app-interface prunes the KEDA cron scaler on every sync, and your bot won't auto-scale. See [Scheduling](scheduling.md).

**Unused env presets waste build time.** The `node` and `go` presets install version managers and compilers. Skip them if your repos don't need them. See [Env Presets](presets/envs.md).

## Troubleshooting

**Bot isn't picking up tickets:**

- Check that tickets have the correct primary label matching your `BOT_LABEL`
- Tickets must be unassigned — the bot skips assigned tickets
- Verify `repo:<name>` labels match keys in `project-repos.json`
- Check if the bot is at the 10-task capacity limit via the dashboard

**Bot pod starts but hangs:**

- Check NetworkPolicy labels (must be `devbot-proxy`, not `proxy`)
- Check DNS egress (port 5353, not 53, targeting `openshift-dns` namespace)
- Verify executor connectivity in logs: "Connected to executor at devbot-proxy:9090"

**Bot runs but never starts AI sessions:**

- Check preflight logs — all scripts returning "skip" means no actionable work was found
- Verify there are open PRs with CI failures, review feedback, or unassigned sprint tickets
- Look for "error" results in preflight output, which indicate API connectivity issues

For the full operations guide, see [OPERATIONS.md](https://github.com/RedHatInsights/platform-frontend-ai-dev/blob/master/OPERATIONS.md).

---

## Documentation

| Section | What you'll find |
|---------|-----------------|
| [Onboarding a New Instance](onboarding-new-instance.md) | Step-by-step guide: runner repo, deploy template, Konflux, app-interface, Jira setup |
| [Scheduling](scheduling.md) | KEDA cron scaler configuration for business-hours-only operation |
| [Bot Workflow Loop](bot-workflow-loop.md) | Cycle architecture, preflight system, task state machine with diagrams |
| [Git Auth Proxy](git-auth-proxy.md) | Credential isolation design for the proxy sidecar |
| [Preset System Design](presets-design.md) | Architecture decisions behind the preset composition model |
| [Presets Overview](presets/README.md) | How workflow and env presets work together |
| [Workflow Presets](presets/workflows.md) | Built-in workflow reference (jira-sprint) |
| [Env Presets](presets/envs.md) | Available env presets: node, go, browser, container-scan, slack, etc. |
| [Custom Workflows](presets/custom-workflows.md) | Building your own workflow for specialized automation |
| [Custom Preflight Scripts](presets/custom-preflight.md) | Writing pre-session data-gathering scripts |
| [Preset Migration Guide](migrations/preset-migration-guide.md) | Migrating existing instances to the preset system |
| [Roadmap](roadmap.md) | Planned improvements and new capabilities |

## Contributing to these docs

Preview changes locally:

```bash
pip install -r docs/requirements.txt
mkdocs serve
```

Open [http://127.0.0.1:8000](http://127.0.0.1:8000) to preview. Run `mkdocs build --strict` before pushing to catch broken links.
