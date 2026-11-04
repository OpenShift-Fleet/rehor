# Dev Bot — Local Development

This file is for **local development only**. Claude runtime paths in `bot/run.py` and the TypeScript coordinator overwrite it with assembled guidance. Keep this output a regular file, separate from canonical preset sources.

## Source of Truth

- **Runtime instructions**: `presets/core/AGENTS.md` — edit this when changing bot behavior
- **Workflow-specific**: `presets/workflows/<name>/AGENTS.md` — per-workflow extensions
- **Claude aliases**: preset `CLAUDE.md` files are relative symlinks to canonical `AGENTS.md` files
- **Claude assembly**: `bot/run.py` → `assemble_claude_md()`; `coordinator/src/instructions.ts` → `assembleInstructions()`
- **OpenCode**: loads core, optional shared, and selected workflow `AGENTS.md` through native `instructions`, plus native profile resources; no Claude assembly

## How Assembly Works

Claude assembly reads `$BOT_CONFIG_PATH/agent/CLAUDE.md` and the preset aliases using one of three strategies. An optional shared `CLAUDE.md` layer follows core in every strategy:

- **`replace`**: core + shared + instance (instance replaces workflow, never core)
- **`append`**: core + shared + workflow + instance
- **`ignore`** (default): core + shared + workflow (instance file ignored)

The assembled result overwrites this file at startup, so any local edits here are lost in production.

## Local Dev Tips

- To test bot behavior locally, edit `presets/core/AGENTS.md`
- To test a specific workflow, also edit the workflow's `AGENTS.md`
- Run `python bot/run.py` to see the assembled output
- This local development file is not packaged in Docker images; Claude runtime preparation generates the root output
