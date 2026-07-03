"""Tests for preflight runner (bot/preflight.py)."""

import stat

import pytest

from bot.preflight import (
    ScriptResult,
    _aggregate,
    _run_script,
    discover_preflight_scripts,
    run_preflight,
)


@pytest.fixture
def preset_dir(tmp_path):
    """Create a preset directory structure with shared + workflow preflight dirs."""
    wf = tmp_path / "presets" / "workflows" / "test-wf" / "preflight"
    wf.mkdir(parents=True)
    shared = tmp_path / "presets" / "shared" / "preflight"
    shared.mkdir(parents=True)
    (tmp_path / "data").mkdir()
    return tmp_path


def _write_script(path, status="start", content="test content"):
    """Write a minimal preflight script that outputs JSON."""
    path.write_text(f'import json; print(json.dumps({{"status": "{status}", "content": "{content}"}}))\n')
    path.chmod(path.stat().st_mode | stat.S_IEXEC)


# --- discover_preflight_scripts ---


def test_discover_no_scripts(tmp_path):
    result = discover_preflight_scripts(tmp_path, "nonexistent")
    assert result == []


def test_discover_workflow_scripts(preset_dir):
    wf_dir = preset_dir / "presets" / "workflows" / "test-wf" / "preflight"
    _write_script(wf_dir / "01-check.py")
    _write_script(wf_dir / "02-check.py")

    result = discover_preflight_scripts(preset_dir, "test-wf")
    assert len(result) == 2
    assert result[0].name == "01-check.py"
    assert result[1].name == "02-check.py"


def test_discover_instance_scripts(preset_dir, tmp_path):
    wf_dir = preset_dir / "presets" / "workflows" / "test-wf" / "preflight"
    _write_script(wf_dir / "01-check.py")

    inst_dir = tmp_path / "instance"
    inst_pf = inst_dir / "preflight"
    inst_pf.mkdir(parents=True)
    _write_script(inst_pf / "50-custom.py")

    result = discover_preflight_scripts(preset_dir, "test-wf", remote_agent_dir=inst_dir)
    assert len(result) == 2
    assert result[0].name == "01-check.py"
    assert result[1].name == "50-custom.py"


def test_discover_ordering(preset_dir, tmp_path):
    wf_dir = preset_dir / "presets" / "workflows" / "test-wf" / "preflight"
    _write_script(wf_dir / "02-second.py")
    _write_script(wf_dir / "01-first.py")

    result = discover_preflight_scripts(preset_dir, "test-wf")
    assert [s.name for s in result] == ["01-first.py", "02-second.py"]


def test_discover_ignores_non_py(preset_dir):
    wf_dir = preset_dir / "presets" / "workflows" / "test-wf" / "preflight"
    _write_script(wf_dir / "01-check.py")
    (wf_dir / "README.md").write_text("not a script")
    (wf_dir / "data.json").write_text("{}")

    result = discover_preflight_scripts(preset_dir, "test-wf")
    assert len(result) == 1
    assert result[0].name == "01-check.py"


# --- _run_script ---


def test_run_script_start(preset_dir):
    wf_dir = preset_dir / "presets" / "workflows" / "test-wf" / "preflight"
    script = wf_dir / "01-test.py"
    _write_script(script, status="start", content="work found")

    result = _run_script(script, preset_dir)
    assert result.status == "start"
    assert result.content == "work found"
    assert result.name == "01-test.py"


def test_run_script_skip(preset_dir):
    wf_dir = preset_dir / "presets" / "workflows" / "test-wf" / "preflight"
    script = wf_dir / "01-test.py"
    _write_script(script, status="skip", content="nothing to do")

    result = _run_script(script, preset_dir)
    assert result.status == "skip"
    assert result.content == "nothing to do"


def test_run_script_error_status(preset_dir):
    wf_dir = preset_dir / "presets" / "workflows" / "test-wf" / "preflight"
    script = wf_dir / "01-test.py"
    _write_script(script, status="error", content="something broke")

    result = _run_script(script, preset_dir)
    assert result.status == "error"
    assert result.content == "something broke"


def test_run_script_invalid_json(preset_dir):
    wf_dir = preset_dir / "presets" / "workflows" / "test-wf" / "preflight"
    script = wf_dir / "01-test.py"
    script.write_text('print("not json")\n')

    result = _run_script(script, preset_dir)
    assert result.status == "error"
    assert "invalid JSON" in result.content


def test_run_script_nonzero_exit(preset_dir):
    wf_dir = preset_dir / "presets" / "workflows" / "test-wf" / "preflight"
    script = wf_dir / "01-test.py"
    script.write_text("import sys; sys.exit(1)\n")

    result = _run_script(script, preset_dir)
    assert result.status == "error"
    assert "exited with code 1" in result.content


def test_run_script_unknown_status(preset_dir):
    wf_dir = preset_dir / "presets" / "workflows" / "test-wf" / "preflight"
    script = wf_dir / "01-test.py"
    script.write_text('import json; print(json.dumps({"status": "bogus", "content": "x"}))\n')

    result = _run_script(script, preset_dir)
    assert result.status == "error"
    assert "unknown status" in result.content


def test_run_script_start_empty_content(preset_dir):
    wf_dir = preset_dir / "presets" / "workflows" / "test-wf" / "preflight"
    script = wf_dir / "01-test.py"
    script.write_text('import json; print(json.dumps({"status": "start", "content": ""}))\n')

    result = _run_script(script, preset_dir)
    assert result.status == "error"
    assert "empty content" in result.content


def test_run_script_no_output(preset_dir):
    wf_dir = preset_dir / "presets" / "workflows" / "test-wf" / "preflight"
    script = wf_dir / "01-test.py"
    script.write_text("pass\n")

    result = _run_script(script, preset_dir)
    assert result.status == "error"
    assert "no output" in result.content


def test_run_script_sets_pythonpath(preset_dir):
    """Verify PYTHONPATH includes shared preflight and skills dirs."""
    wf_dir = preset_dir / "presets" / "workflows" / "test-wf" / "preflight"
    script = wf_dir / "01-test.py"
    # Script prints PYTHONPATH as content
    script.write_text(
        'import json, os; print(json.dumps({"status": "start", "content": os.environ.get("PYTHONPATH", "")}))\n'
    )

    result = _run_script(script, preset_dir)
    assert result.status == "start"
    shared_path = str(preset_dir / "presets" / "shared" / "preflight")
    skills_path = str(preset_dir / ".claude" / "skills")
    assert shared_path in result.content
    assert skills_path in result.content


# --- _aggregate ---


def test_aggregate_all_start():
    results = [
        ScriptResult("a.py", "start", "content a"),
        ScriptResult("b.py", "start", "content b"),
    ]
    r = _aggregate(results)
    assert r.action == "start"
    assert "content a" in r.prompt
    assert "content b" in r.prompt


def test_aggregate_all_skip():
    results = [
        ScriptResult("a.py", "skip", "nothing a"),
        ScriptResult("b.py", "skip", "nothing b"),
    ]
    r = _aggregate(results)
    assert r.action == "skip"
    assert "nothing a" in r.transcript


def test_aggregate_mixed_start_skip():
    results = [
        ScriptResult("a.py", "skip", "nothing"),
        ScriptResult("b.py", "start", "work found"),
    ]
    r = _aggregate(results)
    assert r.action == "start"
    assert "work found" in r.prompt
    assert "nothing" in r.prompt


def test_aggregate_error_excluded_start_wins():
    results = [
        ScriptResult("a.py", "start", "work found"),
        ScriptResult("b.py", "error", "boom"),
    ]
    r = _aggregate(results)
    assert r.action == "start"
    assert "work found" in r.prompt
    assert "PREFLIGHT ERROR" in r.prompt
    assert "boom" in r.prompt


def test_aggregate_error_excluded_skip_wins():
    results = [
        ScriptResult("a.py", "skip", "nothing"),
        ScriptResult("b.py", "error", "boom"),
    ]
    r = _aggregate(results)
    assert r.action == "skip"
    assert "PREFLIGHT ERROR" in r.transcript


def test_aggregate_all_error():
    results = [ScriptResult("a.py", "error", "crash")]
    r = _aggregate(results)
    assert r.action == "error"
    assert "crash" in r.transcript


# --- run_preflight ---


def test_run_preflight_no_scripts(tmp_path):
    result = run_preflight(tmp_path, "nonexistent")
    assert result is None


def test_run_preflight_start(preset_dir):
    wf_dir = preset_dir / "presets" / "workflows" / "test-wf" / "preflight"
    _write_script(wf_dir / "01-check.py", status="start", content="work here")

    result = run_preflight(preset_dir, "test-wf")
    assert result is not None
    assert result.action == "start"
    assert "work here" in result.prompt
    assert len(result.scripts) == 1


def test_run_preflight_skip(preset_dir):
    wf_dir = preset_dir / "presets" / "workflows" / "test-wf" / "preflight"
    _write_script(wf_dir / "01-check.py", status="skip", content="idle")

    result = run_preflight(preset_dir, "test-wf")
    assert result is not None
    assert result.action == "skip"
    assert "idle" in result.transcript


def test_run_preflight_error(preset_dir):
    wf_dir = preset_dir / "presets" / "workflows" / "test-wf" / "preflight"
    _write_script(wf_dir / "01-check.py", status="error", content="broken")

    result = run_preflight(preset_dir, "test-wf")
    assert result is not None
    assert result.action == "error"


def test_run_preflight_cleans_state_file(preset_dir):
    wf_dir = preset_dir / "presets" / "workflows" / "test-wf" / "preflight"
    _write_script(wf_dir / "01-check.py", status="skip", content="done")

    state_file = preset_dir / "data" / "preflight-state.json"
    state_file.parent.mkdir(parents=True, exist_ok=True)
    state_file.write_text('{"leftover": true}')

    run_preflight(preset_dir, "test-wf")
    assert not state_file.exists()


def test_run_preflight_multiple_scripts(preset_dir):
    wf_dir = preset_dir / "presets" / "workflows" / "test-wf" / "preflight"
    _write_script(wf_dir / "01-skip.py", status="skip", content="nothing")
    _write_script(wf_dir / "02-start.py", status="start", content="found work")

    result = run_preflight(preset_dir, "test-wf")
    assert result is not None
    assert result.action == "start"
    assert len(result.scripts) == 2
    assert "found work" in result.prompt
