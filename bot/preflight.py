"""Pre-flight script runner — executes data-gathering scripts before Claude session.

Each script prints JSON to stdout: {"status": "start"|"skip"|"error", "content": "..."}
- start: work found, content becomes session prompt
- skip: nothing to do, content logged as orphan cycle
- error: script failed, content logged, backoff applied

Aggregation: any error → no session. Any start → session starts. All skip → no session.
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

logger = logging.getLogger(__name__)

PREFLIGHT_TIMEOUT = 120
STATE_FILENAME = "preflight-state.json"


@dataclass
class ScriptResult:
    name: str
    status: str  # "start" | "skip" | "error"
    content: str


@dataclass
class PreflightResult:
    action: str  # "start" | "skip" | "error"
    prompt: str = ""
    transcript: str = ""
    scripts: list[ScriptResult] = field(default_factory=list)


def discover_preflight_scripts(
    script_dir: Path,
    workflow: str,
    remote_agent_dir: Path | None = None,
) -> list[Path]:
    """Find preflight scripts from workflow preset + instance config, sorted by name."""
    scripts: list[Path] = []

    workflow_preflight = script_dir / "presets" / "workflows" / workflow / "preflight"
    if workflow_preflight.is_dir():
        scripts.extend(sorted(f for f in workflow_preflight.iterdir() if f.suffix == ".py" and f.is_file()))

    if remote_agent_dir:
        instance_preflight = remote_agent_dir / "preflight"
        if instance_preflight.is_dir():
            scripts.extend(sorted(f for f in instance_preflight.iterdir() if f.suffix == ".py" and f.is_file()))

    return scripts


def _run_script(script: Path, script_dir: Path) -> ScriptResult:
    """Run a single preflight script and parse its JSON output."""
    name = script.name
    env = os.environ.copy()
    shared_preflight = script_dir / "presets" / "shared" / "preflight"
    skills_dir = script_dir / ".claude" / "skills"
    extra = [str(shared_preflight), str(skills_dir)]
    existing = env.get("PYTHONPATH", "")
    env["PYTHONPATH"] = os.pathsep.join(extra + ([existing] if existing else []))
    try:
        proc = subprocess.run(
            ["python3", str(script)],
            capture_output=True,
            text=True,
            timeout=PREFLIGHT_TIMEOUT,
            cwd=str(script_dir),
            env=env,
        )
    except subprocess.TimeoutExpired:
        logger.error("Preflight %s timed out after %ds", name, PREFLIGHT_TIMEOUT)
        return ScriptResult(name=name, status="error", content=f"{name} timed out after {PREFLIGHT_TIMEOUT}s")

    if proc.returncode != 0:
        stderr = proc.stderr.strip() or f"{name} exited with code {proc.returncode}"
        logger.error("Preflight %s failed (exit %d): %s", name, proc.returncode, stderr[:200])
        return ScriptResult(name=name, status="error", content=stderr)

    stdout = proc.stdout.strip()
    if not stdout:
        logger.error("Preflight %s produced no output", name)
        return ScriptResult(name=name, status="error", content=f"{name} produced no output")

    try:
        data = json.loads(stdout)
    except json.JSONDecodeError as exc:
        logger.error("Preflight %s output is not valid JSON: %s", name, exc)
        return ScriptResult(name=name, status="error", content=f"{name} invalid JSON: {exc}\nstdout: {stdout[:500]}")

    status = data.get("status", "")
    content = data.get("content", "")

    if status not in ("start", "skip", "error"):
        logger.error("Preflight %s returned unknown status: %s", name, status)
        return ScriptResult(name=name, status="error", content=f"{name} unknown status: {status}")

    if status == "start" and not content:
        logger.error("Preflight %s returned start with empty content", name)
        return ScriptResult(name=name, status="error", content=f"{name} returned start with empty content")

    logger.info("Preflight %s → %s (%d chars)", name, status, len(content))
    return ScriptResult(name=name, status=status, content=content)


def _aggregate(results: list[ScriptResult]) -> PreflightResult:
    """Aggregate script results: errors excluded, any start → start, all skip → skip.

    Errored scripts are logged but don't block the cycle — the remaining
    scripts are aggregated normally. This avoids a transient API failure
    (e.g. GitHub timeout) blocking Jira work that a different script found.
    Only when ALL scripts error does the cycle become an error.
    """
    ok = [r for r in results if r.status != "error"]
    errors = [r for r in results if r.status == "error"]

    if errors:
        for e in errors:
            logger.warning("Preflight %s errored (excluded from aggregation): %s", e.name, e.content[:200])

    if not ok:
        all_content = "\n\n".join(r.content for r in results if r.content)
        return PreflightResult(action="error", transcript=all_content, scripts=results)

    has_start = any(r.status == "start" for r in ok)
    all_content = "\n\n".join(r.content for r in ok if r.content)
    if errors:
        error_summary = "\n".join(f"[PREFLIGHT ERROR] {e.name}: {e.content[:200]}" for e in errors)
        all_content = f"{error_summary}\n\n{all_content}" if all_content else error_summary

    if has_start:
        return PreflightResult(action="start", prompt=all_content, scripts=results)

    return PreflightResult(action="skip", transcript=all_content, scripts=results)


def run_preflight(
    script_dir: Path,
    workflow: str,
    remote_agent_dir: Path | None = None,
    instance_id: str | None = None,
) -> PreflightResult | None:
    """Run all preflight scripts and return aggregated result.

    Returns None if no preflight scripts exist (pass-through to normal cycle).
    """
    scripts = discover_preflight_scripts(script_dir, workflow, remote_agent_dir)
    if not scripts:
        logger.debug("No preflight scripts found — pass-through")
        return None

    logger.info("Running %d preflight script(s): %s", len(scripts), [s.name for s in scripts])

    results: list[ScriptResult] = []
    for script in scripts:
        result = _run_script(script, script_dir)
        results.append(result)

    # Clean up shared state file
    state_file = script_dir / "data" / STATE_FILENAME
    state_file.unlink(missing_ok=True)

    return _aggregate(results)
