---
name: detect-tech-stack
description: >
  Analyze a cloned repo to detect its tech stack, suggest env presets, and
  recommend personas. Outputs structured JSON with detection results.
when_to_use: >
  During onboarding intake or scaffolding phase when the bot needs to determine
  which env presets and personas to configure for a new instance. Also useful
  for any workflow that needs to select personas or presets dynamically.
user-invocable: true
allowed-tools:
  - "Bash(python3 .claude/skills/detect-tech-stack/detect_tech_stack.py *)"
  - Read
---

```bash
python3 .claude/skills/detect-tech-stack/detect_tech_stack.py <repo_path> 2>&1
```

Scans the repo directory for language/framework markers and outputs JSON:

```json
{
  "stack": ["react", "patternfly", "typescript"],
  "suggested_envs": ["node", "browser"],
  "suggested_personas": ["frontend"],
  "default_branch": "master",
  "has_dockerfile": true,
  "visibility": "public",
  "note": "Suggestions based on file markers. Review and adjust before use."
}
```

## Output is a Starting Point

Detection output is a **suggestion**, not a prescription. The agent should:

1. Run detection on each repo to get a baseline
2. Review the suggestions and adjust based on context (e.g., a Go repo that only runs tests may not need the full `go` env)
3. Reference an existing instance to understand the **structure** (how envs and personas are organized), not to copy its stack choices. Read its `instance/*/agent/instance.yaml` and `instance/*/agent/personas/` to see the layout:
   - **hcc-framework-agent-dev**: https://github.com/RedHatInsights/hcc-framework-agent-dev (Node/Go/PatternFly/browser with frontend, backend, operator, config, and tooling personas)
   - Use this as a structural reference only — the onboarding team's actual stack may be completely different
4. Let the team confirm or override env/persona choices during intake

The persona templates in `generate-instance` are similarly just starting points — teams should customize them after scaffolding.

## Detection Heuristics

| Marker | Stack tag | Suggested envs | Suggested persona |
|--------|-----------|----------------|-------------------|
| `package.json` + React | `react` | `node`, `browser` | `frontend` |
| `package.json` + PatternFly | `patternfly` | `patternfly-mcp` | `frontend` |
| `go.mod` | `go` | `go` | `backend` |
| `go.mod` + `operator-sdk` | `operator` | `go` | `operator` |
| `Pipfile`/`requirements.txt` + Django | `django` | — | `backend` |
| `Dockerfile` only (no app code) | `tooling` | — | `tooling` |
| YAML/config-heavy repo | `config` | — | `config` |
| TypeScript (`tsconfig.json`) | `typescript` | — | — |

Multiple stacks can be detected (e.g., a monorepo with both Go and React).
