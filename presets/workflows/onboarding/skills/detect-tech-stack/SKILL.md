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
  "envs": ["node", "browser"],
  "personas": ["frontend"],
  "default_branch": "master",
  "has_dockerfile": true,
  "visibility": "public"
}
```

## Detection Rules

| Marker | Stack tag | Env presets | Persona |
|--------|-----------|-------------|---------|
| `package.json` + React | `react` | `node`, `browser` | `frontend` |
| `package.json` + PatternFly | `patternfly` | `patternfly-mcp` | `frontend` |
| `go.mod` | `go` | `go` | `backend` |
| `go.mod` + `operator-sdk` | `operator` | `go` | `operator` |
| `Pipfile`/`requirements.txt` + Django | `django` | — | `backend` |
| `Dockerfile` only (no app code) | `tooling` | — | `tooling` |
| YAML/config-heavy repo | `config` | — | `config` |
| TypeScript (`tsconfig.json`) | `typescript` | — | — |

Multiple stacks can be detected (e.g., a monorepo with both Go and React).
