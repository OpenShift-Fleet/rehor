# Dev Bot — Local Development

This file is for **local development only**. At runtime, `bot/run.py` overwrites this file by assembling instructions from `presets/core/CLAUDE.md` + workflow-specific CLAUDE.md files.

## Source of Truth

- **Runtime instructions**: `presets/core/CLAUDE.md` — edit this when changing bot behavior
- **Workflow-specific**: `presets/workflows/<name>/CLAUDE.md` — per-workflow extensions
- **Assembly logic**: `bot/run.py` → `assemble_claude_md()`

## How Assembly Works

`run.py` reads from `$BOT_CONFIG_PATH/agent/CLAUDE.md` (the instance workflow file) and combines it with `presets/core/CLAUDE.md` using one of three strategies:

- **`replace`**: core + instance (workflow file replaces core entirely — not recommended)
- **`append`** (default): core + workflow + instance (workflow instructions appended after core)
- **`ignore`**: core + workflow (instance file ignored)

The assembled result overwrites this file at startup, so any local edits here are lost in production.

## Local Dev Tips

- To test bot behavior locally, edit `presets/core/CLAUDE.md`
- To test a specific workflow, also edit the workflow's CLAUDE.md
- Run `python bot/run.py` to see the assembled output
- This file is copied into the Docker image but immediately overwritten at container startup
