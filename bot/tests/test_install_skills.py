"""Tests for install_skills() — shared/workflow/env skill installation."""

import shutil
from pathlib import Path

import pytest
import yaml

from bot.merge import install_skills


@pytest.fixture
def skill_env(tmp_path):
    """Set up a minimal preset tree for skill installation tests."""
    skills_dir = tmp_path / ".claude" / "skills"
    skills_dir.mkdir(parents=True)

    shared_skills = tmp_path / "presets" / "shared" / "skills"
    shared_skills.mkdir(parents=True)

    workflows = tmp_path / "presets" / "workflows"
    workflows.mkdir(parents=True)

    envs = tmp_path / "presets" / "envs"
    envs.mkdir(parents=True)

    return tmp_path


def _make_skill(base_dir: Path, name: str, content: str = ""):
    """Create a minimal skill directory with a SKILL.md file."""
    skill_dir = base_dir / name
    skill_dir.mkdir(parents=True, exist_ok=True)
    (skill_dir / "SKILL.md").write_text(content or f"# {name}\nSkill docs.")
    return skill_dir


def _make_workflow(skill_env, name, shared_skills=None, provides_skills=None):
    """Create a workflow dir with manifest.yaml."""
    wf_dir = skill_env / "presets" / "workflows" / name
    wf_dir.mkdir(parents=True, exist_ok=True)
    manifest = {"name": name, "type": "workflow"}
    if shared_skills:
        manifest["shared_skills"] = shared_skills
    if provides_skills:
        manifest["provides"] = {"skills": provides_skills}
    (wf_dir / "manifest.yaml").write_text(yaml.dump(manifest))
    return wf_dir


def _make_env(skill_env, name, provides_skills=None):
    """Create an env preset dir with manifest.yaml."""
    env_dir = skill_env / "presets" / "envs" / name
    env_dir.mkdir(parents=True, exist_ok=True)
    manifest = {"name": name, "type": "env"}
    if provides_skills:
        manifest["provides"] = {"skills": provides_skills}
    (env_dir / "manifest.yaml").write_text(yaml.dump(manifest))
    return env_dir


class TestInstallSkills:
    def test_shared_skills_installed(self, skill_env):
        shared_dir = skill_env / "presets" / "shared" / "skills"
        _make_skill(shared_dir, "push-and-pr")
        _make_skill(shared_dir, "post-pr")

        wf_dir = _make_workflow(skill_env, "test-wf", shared_skills=["push-and-pr", "post-pr"])

        result = install_skills(skill_env, wf_dir, [])

        assert (skill_env / ".claude" / "skills" / "push-and-pr" / "SKILL.md").exists()
        assert (skill_env / ".claude" / "skills" / "post-pr" / "SKILL.md").exists()
        assert "shared:push-and-pr" in result
        assert "shared:post-pr" in result

    def test_workflow_skills_installed(self, skill_env):
        wf_dir = _make_workflow(skill_env, "test-wf", provides_skills=["claim-ticket"])
        _make_skill(wf_dir / "skills", "claim-ticket")

        result = install_skills(skill_env, wf_dir, [])

        assert (skill_env / ".claude" / "skills" / "claim-ticket" / "SKILL.md").exists()
        assert "workflow:claim-ticket" in result

    def test_env_skills_installed(self, skill_env):
        env_dir = _make_env(skill_env, "slack", provides_skills=["slack-notify"])
        _make_skill(env_dir / "skills", "slack-notify")

        wf_dir = _make_workflow(skill_env, "test-wf")

        result = install_skills(skill_env, wf_dir, ["slack"])

        assert (skill_env / ".claude" / "skills" / "slack-notify" / "SKILL.md").exists()
        assert "env/slack:slack-notify" in result

    def test_merge_order_workflow_overrides_shared(self, skill_env):
        shared_dir = skill_env / "presets" / "shared" / "skills"
        _make_skill(shared_dir, "claim-ticket", "shared version")

        wf_dir = _make_workflow(skill_env, "test-wf", shared_skills=["claim-ticket"], provides_skills=["claim-ticket"])
        _make_skill(wf_dir / "skills", "claim-ticket", "workflow version")

        install_skills(skill_env, wf_dir, [])

        content = (skill_env / ".claude" / "skills" / "claim-ticket" / "SKILL.md").read_text()
        assert content == "workflow version"

    def test_merge_order_env_overrides_workflow(self, skill_env):
        wf_dir = _make_workflow(skill_env, "test-wf", provides_skills=["my-skill"])
        _make_skill(wf_dir / "skills", "my-skill", "workflow version")

        env_dir = _make_env(skill_env, "browser", provides_skills=["my-skill"])
        _make_skill(env_dir / "skills", "my-skill", "env version")

        install_skills(skill_env, wf_dir, ["browser"])

        content = (skill_env / ".claude" / "skills" / "my-skill" / "SKILL.md").read_text()
        assert content == "env version"

    def test_missing_shared_skill_warns(self, skill_env, caplog):
        wf_dir = _make_workflow(skill_env, "test-wf", shared_skills=["nonexistent"])

        result = install_skills(skill_env, wf_dir, [])

        assert len(result) == 0
        assert "not found" in caplog.text

    def test_missing_workflow_skill_dir_skipped(self, skill_env):
        wf_dir = _make_workflow(skill_env, "test-wf", provides_skills=["triage"])

        result = install_skills(skill_env, wf_dir, [])

        assert len(result) == 0
        assert not (skill_env / ".claude" / "skills" / "triage").exists()

    def test_no_manifest_installs_nothing(self, skill_env):
        wf_dir = skill_env / "presets" / "workflows" / "bare"
        wf_dir.mkdir(parents=True)

        result = install_skills(skill_env, wf_dir, [])

        assert result == []

    def test_inactive_envs_not_installed(self, skill_env):
        env_dir = _make_env(skill_env, "browser", provides_skills=["gh-release-upload"])
        _make_skill(env_dir / "skills", "gh-release-upload")

        wf_dir = _make_workflow(skill_env, "test-wf")

        result = install_skills(skill_env, wf_dir, ["slack"])

        assert not (skill_env / ".claude" / "skills" / "gh-release-upload").exists()
        assert len(result) == 0

    def test_existing_skill_replaced(self, skill_env):
        skills_dir = skill_env / ".claude" / "skills"
        _make_skill(skills_dir, "push-and-pr", "old version")

        shared_dir = skill_env / "presets" / "shared" / "skills"
        _make_skill(shared_dir, "push-and-pr", "new version")

        wf_dir = _make_workflow(skill_env, "test-wf", shared_skills=["push-and-pr"])

        install_skills(skill_env, wf_dir, [])

        content = (skills_dir / "push-and-pr" / "SKILL.md").read_text()
        assert content == "new version"

    def test_full_merge_order(self, skill_env):
        shared_dir = skill_env / "presets" / "shared" / "skills"
        _make_skill(shared_dir, "push-and-pr")
        _make_skill(shared_dir, "auto-fork")

        wf_dir = _make_workflow(
            skill_env,
            "jira-sprint",
            shared_skills=["push-and-pr", "auto-fork"],
            provides_skills=["claim-ticket", "wrap-up"],
        )
        _make_skill(wf_dir / "skills", "claim-ticket")
        _make_skill(wf_dir / "skills", "wrap-up")

        env_dir = _make_env(skill_env, "slack", provides_skills=["slack-notify"])
        _make_skill(env_dir / "skills", "slack-notify")

        result = install_skills(skill_env, wf_dir, ["slack"])

        skills_dir = skill_env / ".claude" / "skills"
        assert (skills_dir / "push-and-pr").exists()
        assert (skills_dir / "auto-fork").exists()
        assert (skills_dir / "claim-ticket").exists()
        assert (skills_dir / "wrap-up").exists()
        assert (skills_dir / "slack-notify").exists()
        assert len(result) == 5
