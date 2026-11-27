# Bot Workflow Loop

The dispatcher decides whether work warrants an OpenCode session. Preflights use no model tokens.

1. **Load profiles.** The dispatcher syncs instance repositories and reads each profile's `instance.yaml`.
2. **Check for work.** It validates the full [preflight list](presets/custom-preflight.md) before running checks in order. Invalid configuration blocks the run. Without a `start` result, no sandbox launches. An actionable `start` can proceed even when a different check fails.
3. **Run once.** The dispatcher passes only `start` content into a new OpenShell sandbox. The coordinator consumes it, runs one OpenCode V2 cycle, and exits. It does not poll or run preflights again.
4. **Clean up.** The dispatcher removes run-owned resources. See [session reconciliation](agent-dispatcher-deployment.md#durable-session-registry-and-startup-reconciliation) for restart behavior.

## Dispatcher sandbox input

The dispatcher writes a JSON envelope to `/tmp/rehor-input.json` and passes its path using `REHOR_INPUT_FILE` with `REHOR_INPUT_SOURCE=sandbox`. The envelope carries the run ID, prompt, and preflight metadata. Its serialized size is capped at 1 MiB. The prompt is not passed in argv or environment variables. The runner requires `BOT_EXECUTION_ENGINE=coordinator` and `runtime: opencode`; it exits without launching a session if required input is missing, malformed, or oversized. A valid but blank prompt skips the session.

## Work across cycles

The workflow instructions decide what to do with the preflight evidence. Common actions include claiming a new task, resuming interrupted work, addressing CI or review feedback, and closing a task after its PR or MR merges. Preflights read state; the agent performs updates through workflow tools. The memory server persists tasks and cycle records, so a new sandbox does not need the previous session to remain running.

See [workflow presets](presets/workflows.md) for routing and [debugging](debugging-cycles-and-agents.md) for cycle evidence.
