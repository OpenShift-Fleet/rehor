"""Tests for scaffold_custom_workflow."""

import argparse
import sys
from pathlib import Path

import pytest
import yaml

SKILL_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SKILL_DIR))

from scaffold_custom_workflow import (  # noqa: E402
    parse_csv,
    render_claude_md_jira,
    render_claude_md_scheduled,
    render_manifest,
    render_preflight_jira,
    render_preflight_scheduled,
    scaffold,
    validate_name,
)

BASE_CFG = {
    "name": "my-workflow",
    "description": "A test workflow",
    "trigger": "jira",
    "output_dir": "",  # set per test via tmp_path
    "mcp_servers": [],
    "env_vars": [],
    "shared_skills": [],
}


def cfg_with(tmp_path, **overrides):
    c = {**BASE_CFG, "output_dir": str(tmp_path), **overrides}
    return c


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


class TestValidation:
    def test_valid_kebab_names(self):
        for name in ["watchduty", "my-workflow", "pr-review2", "ab12-cd"]:
            assert validate_name(name) == name

    def test_rejects_uppercase(self):
        with pytest.raises(argparse.ArgumentTypeError):
            validate_name("MyWorkflow")

    def test_rejects_underscores(self):
        with pytest.raises(argparse.ArgumentTypeError):
            validate_name("my_workflow")

    def test_rejects_leading_digit(self):
        with pytest.raises(argparse.ArgumentTypeError):
            validate_name("1workflow")

    def test_rejects_trailing_hyphen(self):
        with pytest.raises(argparse.ArgumentTypeError):
            validate_name("my-workflow-")

    def test_rejects_double_hyphen(self):
        with pytest.raises(argparse.ArgumentTypeError):
            validate_name("my--workflow")

    def test_rejects_single_char(self):
        with pytest.raises(argparse.ArgumentTypeError):
            validate_name("a")

    def test_parse_csv_empty(self):
        assert parse_csv("") == []

    def test_parse_csv_values(self):
        assert parse_csv("a, b, c") == ["a", "b", "c"]


# ---------------------------------------------------------------------------
# Manifest
# ---------------------------------------------------------------------------


class TestManifest:
    def test_basic_manifest(self):
        text = render_manifest(BASE_CFG)
        data = yaml.safe_load(text)
        assert data["name"] == "my-workflow"
        assert data["type"] == "workflow"
        assert data["description"] == "A test workflow"
        assert data["preflight"] == ["01-check.py"]
        assert data["provides"]["claude_md"] == "CLAUDE.md"

    def test_manifest_with_mcp_and_env(self):
        cfg = {**BASE_CFG, "mcp_servers": ["bot-memory", "mcp-atlassian"], "env_vars": ["BOT_LABEL"]}
        data = yaml.safe_load(render_manifest(cfg))
        assert data["requires"]["mcp_servers"] == ["bot-memory", "mcp-atlassian"]
        assert data["requires"]["env_vars"] == ["BOT_LABEL"]

    def test_manifest_with_shared_skills(self):
        cfg = {**BASE_CFG, "shared_skills": ["push-and-pr", "post-pr"]}
        data = yaml.safe_load(render_manifest(cfg))
        assert data["shared_skills"] == ["push-and-pr", "post-pr"]

    def test_manifest_no_requires_when_empty(self):
        data = yaml.safe_load(render_manifest(BASE_CFG))
        assert "requires" not in data


# ---------------------------------------------------------------------------
# CLAUDE.md
# ---------------------------------------------------------------------------


class TestClaudeMd:
    def test_jira_mentions_jira(self):
        md = render_claude_md_jira(BASE_CFG)
        assert 'source_type="jira"' in md
        assert "Jira" in md
        assert "cycle-sleep.json" not in md

    def test_scheduled_mentions_sleep(self):
        md = render_claude_md_scheduled(BASE_CFG)
        assert "cycle-sleep.json" in md
        assert 'source_type="scheduled"' in md

    def test_title_uses_workflow_name(self):
        cfg = {**BASE_CFG, "name": "pr-review"}
        md = render_claude_md_jira(cfg)
        assert "# Pr Review Workflow" in md

    def test_description_appears(self):
        md = render_claude_md_jira(BASE_CFG)
        assert "A test workflow" in md


# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------


class TestPreflight:
    def test_jira_imports_common(self):
        py = render_preflight_jira(BASE_CFG)
        assert "from common import" in py
        assert "get_tasks" in py
        assert "get_capacity" in py
        assert "output_result" in py

    def test_jira_uses_task_prefix(self):
        cfg = {**BASE_CFG, "name": "code-scan"}
        py = render_preflight_jira(cfg)
        assert 'TASK_KEY_PREFIX = "code-scan:"' in py

    def test_scheduled_is_standalone(self):
        py = render_preflight_scheduled(BASE_CFG)
        assert "from common import" not in py
        assert "THROTTLE_HOURS" in py
        assert "is_throttled" in py

    def test_scheduled_uses_state_file(self):
        cfg = {**BASE_CFG, "name": "health-check"}
        py = render_preflight_scheduled(cfg)
        assert "health-check-last-run.json" in py

    def test_output_contract_jira(self):
        py = render_preflight_jira(BASE_CFG)
        assert '"status": "start"' in py or "output_result" in py

    def test_output_contract_scheduled(self):
        py = render_preflight_scheduled(BASE_CFG)
        assert '"status": "start"' in py
        assert '"status": "skip"' in py


# ---------------------------------------------------------------------------
# Scaffold (integration)
# ---------------------------------------------------------------------------


class TestScaffold:
    def test_creates_all_files(self, tmp_path):
        cfg = cfg_with(tmp_path, trigger="jira")
        results = scaffold(cfg)
        assert len(results) == 3
        assert all(r["status"] == "ok" for r in results)

        wf = tmp_path / "workflows" / "my-workflow"
        assert (wf / "manifest.yaml").exists()
        assert (wf / "CLAUDE.md").exists()
        assert (wf / "preflight" / "01-check.py").exists()

    def test_scheduled_creates_all_files(self, tmp_path):
        cfg = cfg_with(tmp_path, trigger="scheduled")
        scaffold(cfg)
        wf = tmp_path / "workflows" / "my-workflow"
        assert (wf / "manifest.yaml").exists()
        assert (wf / "CLAUDE.md").exists()
        assert (wf / "preflight" / "01-check.py").exists()

        preflight = (wf / "preflight" / "01-check.py").read_text()
        assert "THROTTLE_HOURS" in preflight

    def test_refuses_existing_directory(self, tmp_path):
        cfg = cfg_with(tmp_path)
        scaffold(cfg)
        with pytest.raises(SystemExit):
            scaffold(cfg)

    def test_dry_run_creates_no_files(self, tmp_path):
        cfg = cfg_with(tmp_path)
        results = scaffold(cfg, dry_run=True)
        assert all(r["status"] == "dry-run" for r in results)
        wf = tmp_path / "workflows" / "my-workflow"
        assert not wf.exists()

    def test_dry_run_returns_content(self, tmp_path):
        cfg = cfg_with(tmp_path)
        results = scaffold(cfg, dry_run=True)
        for r in results:
            assert len(r["content"]) > 0

    def test_manifest_is_valid_yaml(self, tmp_path):
        cfg = cfg_with(
            tmp_path,
            mcp_servers=["bot-memory"],
            env_vars=["BOT_LABEL"],
            shared_skills=["push-and-pr"],
        )
        scaffold(cfg)
        manifest_path = tmp_path / "workflows" / "my-workflow" / "manifest.yaml"
        data = yaml.safe_load(manifest_path.read_text())
        assert data["name"] == "my-workflow"
        assert data["requires"]["mcp_servers"] == ["bot-memory"]

    def test_preflight_is_valid_python(self, tmp_path):
        for trigger in ("jira", "scheduled"):
            out = tmp_path / trigger
            cfg = cfg_with(out, trigger=trigger)
            scaffold(cfg)
            preflight_path = out / "workflows" / "my-workflow" / "preflight" / "01-check.py"
            code = preflight_path.read_text()
            compile(code, str(preflight_path), "exec")
