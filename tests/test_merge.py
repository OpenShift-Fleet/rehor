"""Tests for bot.merge — merge engine with protected-key registry."""

import json
import stat


from bot.merge import (
    PROTECTED_HOOKS,
    MergeReport,
    apply_merged_config,
    deep_merge_settings,
    merge_hooks,
    merge_mcp_servers,
    merge_personas,
    merge_project_repos,
    merge_skills,
)


class TestDeepMergeSettings:
    def test_adds_new_keys(self):
        report = MergeReport()
        result = deep_merge_settings(
            {"existing": "value"},
            {"new_key": "new_value"},
            report,
        )
        assert result["existing"] == "value"
        assert result["new_key"] == "new_value"
        assert "settings:new_key" in report.added

    def test_preserves_protected_permissions(self):
        report = MergeReport()
        builtin = {"permissions": {"allow": ["Read", "Write"]}}
        remote = {"permissions": {"allow": ["Bash(rm -rf:*)"]}}
        result = deep_merge_settings(builtin, remote, report)
        assert result["permissions"]["allow"] == ["Read", "Write"]
        assert any("permissions" in p for p in report.protected)

    def test_preserves_protected_sandbox(self):
        report = MergeReport()
        builtin = {"sandbox": {"enabled": True}}
        remote = {"sandbox": {"enabled": False}}
        result = deep_merge_settings(builtin, remote, report)
        assert result["sandbox"]["enabled"] is True
        assert any("sandbox" in p for p in report.protected)

    def test_preserves_protected_hooks(self):
        report = MergeReport()
        builtin = {"hooks": {"PreToolUse": [{"matcher": "Bash"}]}}
        remote = {"hooks": {"PreToolUse": [{"matcher": "evil"}]}}
        result = deep_merge_settings(builtin, remote, report)
        assert result["hooks"]["PreToolUse"] == [{"matcher": "Bash"}]
        assert any("PreToolUse" in p for p in report.protected)

    def test_allows_non_protected_hooks(self):
        report = MergeReport()
        builtin = {"hooks": {"PreToolUse": [{"matcher": "Bash"}]}}
        remote = {"hooks": {"PostExecution": [{"type": "notify"}]}}
        result = deep_merge_settings(builtin, remote, report)
        assert result["hooks"]["PreToolUse"] == [{"matcher": "Bash"}]
        assert result["hooks"]["PostExecution"] == [{"type": "notify"}]

    def test_deep_merge_nested(self):
        report = MergeReport()
        builtin = {"a": {"b": {"c": 1, "d": 2}}}
        remote = {"a": {"b": {"e": 3}}}
        result = deep_merge_settings(builtin, remote, report)
        assert result["a"]["b"] == {"c": 1, "d": 2, "e": 3}
        assert "settings:a.b.e" in report.added

    def test_override_non_protected_value(self):
        report = MergeReport()
        builtin = {"enableAllProjectMcpServers": False}
        remote = {"enableAllProjectMcpServers": True}
        result = deep_merge_settings(builtin, remote, report)
        assert result["enableAllProjectMcpServers"] is True
        assert "settings:enableAllProjectMcpServers" in report.overridden

    def test_empty_remote(self):
        report = MergeReport()
        builtin = {"permissions": {"allow": ["Read"]}, "other": "val"}
        result = deep_merge_settings(builtin, {}, report)
        assert result == builtin
        assert not report.added and not report.overridden and not report.protected


class TestMergeMcpServers:
    def test_adds_new_server(self):
        report = MergeReport()
        builtin = {"mcpServers": {"bot-memory": {"url": "http://localhost"}}}
        remote = {"mcpServers": {"custom-tool": {"command": "my-tool"}}}
        result = merge_mcp_servers(builtin, remote, report)
        assert "custom-tool" in result["mcpServers"]
        assert "mcp:custom-tool" in report.added

    def test_protects_core_servers(self):
        report = MergeReport()
        builtin = {"mcpServers": {"bot-memory": {"url": "http://localhost"}}}
        remote = {"mcpServers": {"bot-memory": {"url": "http://evil.com"}}}
        result = merge_mcp_servers(builtin, remote, report)
        assert result["mcpServers"]["bot-memory"]["url"] == "http://localhost"
        assert "mcp:bot-memory" in report.protected

    def test_protects_all_core_servers(self):
        report = MergeReport()
        builtin = {
            "mcpServers": {
                "bot-memory": {"url": "a"},
                "mcp-atlassian": {"url": "b"},
                "chrome-devtools": {"command": "c"},
            }
        }
        remote = {
            "mcpServers": {
                "bot-memory": {"url": "x"},
                "mcp-atlassian": {"url": "y"},
                "chrome-devtools": {"command": "z"},
            }
        }
        result = merge_mcp_servers(builtin, remote, report)
        assert result["mcpServers"]["bot-memory"]["url"] == "a"
        assert result["mcpServers"]["mcp-atlassian"]["url"] == "b"
        assert result["mcpServers"]["chrome-devtools"]["command"] == "c"
        assert len(report.protected) == 3

    def test_empty_remote(self):
        report = MergeReport()
        builtin = {"mcpServers": {"bot-memory": {"url": "http://localhost"}}}
        result = merge_mcp_servers(builtin, {}, report)
        assert result == builtin


class TestMergeSkills:
    def test_adds_new_skill(self, tmp_path):
        report = MergeReport()
        builtin = tmp_path / "builtin"
        builtin.mkdir()
        remote = tmp_path / "remote"
        remote.mkdir()
        (remote / "custom-skill").mkdir()
        (remote / "custom-skill" / "prompt.md").write_text("hello")

        merge_skills(builtin, remote, report)
        assert (builtin / "custom-skill" / "prompt.md").exists()
        assert "skill:custom-skill" in report.added

    def test_protects_core_skills(self, tmp_path):
        report = MergeReport()
        builtin = tmp_path / "builtin"
        builtin.mkdir()
        (builtin / "triage").mkdir()
        (builtin / "triage" / "prompt.md").write_text("original")

        remote = tmp_path / "remote"
        remote.mkdir()
        (remote / "triage").mkdir()
        (remote / "triage" / "prompt.md").write_text("hacked")

        merge_skills(builtin, remote, report)
        assert (builtin / "triage" / "prompt.md").read_text() == "original"
        assert "skill:triage" in report.protected

    def test_skips_non_directory(self, tmp_path):
        report = MergeReport()
        builtin = tmp_path / "builtin"
        builtin.mkdir()
        remote = tmp_path / "remote"
        remote.mkdir()
        (remote / "readme.txt").write_text("not a skill")

        result = merge_skills(builtin, remote, report)
        assert result == []

    def test_missing_remote_dir(self, tmp_path):
        report = MergeReport()
        builtin = tmp_path / "builtin"
        builtin.mkdir()
        result = merge_skills(builtin, tmp_path / "nonexistent", report)
        assert result == []


class TestMergePersonas:
    def test_adds_new_persona(self, tmp_path):
        report = MergeReport()
        builtin = tmp_path / "builtin"
        builtin.mkdir()

        remote = tmp_path / "remote"
        remote.mkdir()
        (remote / "custom-team").mkdir()
        (remote / "custom-team" / "prompt.md").write_text("custom persona")

        merge_personas(builtin, remote, report)
        assert (builtin / "custom-team" / "prompt.md").read_text() == "custom persona"
        assert "persona:custom-team" in report.added

    def test_remote_wins_on_conflict(self, tmp_path):
        report = MergeReport()
        builtin = tmp_path / "builtin"
        builtin.mkdir()
        (builtin / "frontend").mkdir()
        (builtin / "frontend" / "prompt.md").write_text("default frontend")

        remote = tmp_path / "remote"
        remote.mkdir()
        (remote / "frontend").mkdir()
        (remote / "frontend" / "prompt.md").write_text("customized frontend")

        merge_personas(builtin, remote, report)
        assert (builtin / "frontend" / "prompt.md").read_text() == "customized frontend"
        assert "persona:frontend" in report.overridden

    def test_missing_remote_dir(self, tmp_path):
        report = MergeReport()
        builtin = tmp_path / "builtin"
        builtin.mkdir()
        result = merge_personas(builtin, tmp_path / "nonexistent", report)
        assert result == []


class TestMergeProjectRepos:
    def test_adds_new_repo(self):
        report = MergeReport()
        builtin = {"repo-a": {"url": "https://a.com", "upstream": "https://ua.com"}}
        remote = {"repo-b": {"url": "https://b.com", "upstream": "https://ub.com"}}
        result = merge_project_repos(builtin, remote, report)
        assert "repo-b" in result
        assert result["repo-b"]["url"] == "https://b.com"
        assert "repo:repo-b" in report.added

    def test_protects_url_and_upstream(self):
        report = MergeReport()
        builtin = {
            "repo-a": {"url": "https://safe.com", "upstream": "https://safe-up.com"}
        }
        remote = {
            "repo-a": {
                "url": "https://evil.com",
                "upstream": "https://evil-up.com",
                "host": "gitlab",
            }
        }
        result = merge_project_repos(builtin, remote, report)
        assert result["repo-a"]["url"] == "https://safe.com"
        assert result["repo-a"]["upstream"] == "https://safe-up.com"
        assert result["repo-a"]["host"] == "gitlab"
        assert "repo:repo-a.url" in report.protected
        assert "repo:repo-a.upstream" in report.protected
        assert "repo:repo-a.host" in report.added

    def test_allows_new_fields_on_existing_repo(self):
        report = MergeReport()
        builtin = {"repo-a": {"url": "https://a.com"}}
        remote = {"repo-a": {"readonly": True, "host": "github"}}
        result = merge_project_repos(builtin, remote, report)
        assert result["repo-a"]["readonly"] is True
        assert result["repo-a"]["host"] == "github"
        assert result["repo-a"]["url"] == "https://a.com"

    def test_empty_remote(self):
        report = MergeReport()
        builtin = {"repo-a": {"url": "https://a.com"}}
        result = merge_project_repos(builtin, {}, report)
        assert result == builtin


class TestMergeHooks:
    def test_adds_new_hook(self, tmp_path):
        report = MergeReport()
        builtin = tmp_path / "builtin"
        builtin.mkdir()

        remote = tmp_path / "remote"
        remote.mkdir()
        (remote / "custom-check.sh").write_text("#!/bin/bash\nexit 0")

        merge_hooks(builtin, remote, report)
        dest = builtin / "custom-check.sh"
        assert dest.exists()
        assert dest.stat().st_mode & stat.S_IXUSR
        assert "hook:custom-check.sh" in report.added

    def test_protects_safety_hooks(self, tmp_path):
        report = MergeReport()
        builtin = tmp_path / "builtin"
        builtin.mkdir()
        (builtin / "validate-bash.sh").write_text("#!/bin/bash\n# safe")

        remote = tmp_path / "remote"
        remote.mkdir()
        (remote / "validate-bash.sh").write_text("#!/bin/bash\n# evil bypass")

        merge_hooks(builtin, remote, report)
        assert (builtin / "validate-bash.sh").read_text() == "#!/bin/bash\n# safe"
        assert "hook:validate-bash.sh" in report.protected

    def test_protects_all_safety_hooks(self, tmp_path):
        report = MergeReport()
        builtin = tmp_path / "builtin"
        builtin.mkdir()

        remote = tmp_path / "remote"
        remote.mkdir()
        for name in PROTECTED_HOOKS:
            (remote / name).write_text("evil")

        merge_hooks(builtin, remote, report)
        assert len(report.protected) == len(PROTECTED_HOOKS)

    def test_missing_remote_dir(self, tmp_path):
        report = MergeReport()
        builtin = tmp_path / "builtin"
        builtin.mkdir()
        result = merge_hooks(builtin, tmp_path / "nonexistent", report)
        assert result == []


class TestApplyMergedConfig:
    def _setup_dirs(self, tmp_path):
        """Create minimal project structure."""
        script_dir = tmp_path / "project"
        script_dir.mkdir()
        (script_dir / "personas").mkdir()
        (script_dir / ".claude" / "skills").mkdir(parents=True)
        (script_dir / ".claude" / "hooks").mkdir(parents=True)
        (script_dir / "bot").mkdir()
        (script_dir / "data").mkdir()
        (script_dir / "bot" / "mcp.json").write_text(
            json.dumps({"mcpServers": {"mcp-atlassian": {"url": "http://jira"}}})
        )
        (script_dir / ".claude" / "settings.json").write_text(
            json.dumps(
                {"permissions": {"allow": ["Read"]}, "sandbox": {"enabled": True}}
            )
        )
        (script_dir / "project-repos.json").write_text(
            json.dumps(
                {"repo-a": {"url": "https://safe.com", "upstream": "https://up.com"}}
            )
        )

        remote = tmp_path / "remote"
        remote.mkdir()
        return script_dir, remote

    def test_empty_remote_preserves_defaults(self, tmp_path):
        script_dir, remote = self._setup_dirs(tmp_path)
        report = apply_merged_config(script_dir, remote)
        assert not report.added
        assert not report.overridden
        assert not report.protected

        settings = json.loads((script_dir / ".claude" / "settings.json").read_text())
        assert settings["permissions"]["allow"] == ["Read"]

    def test_full_merge(self, tmp_path):
        script_dir, remote = self._setup_dirs(tmp_path)

        # Remote personas
        (remote / "personas" / "custom-team").mkdir(parents=True)
        (remote / "personas" / "custom-team" / "prompt.md").write_text("custom")

        # Remote project-repos trying to override url
        (remote / "project-repos.json").write_text(
            json.dumps(
                {
                    "repo-a": {"url": "https://evil.com", "host": "gitlab"},
                    "repo-b": {"url": "https://new.com"},
                }
            )
        )

        # Remote skills with protected + custom
        (remote / "skills" / "triage").mkdir(parents=True)
        (remote / "skills" / "triage" / "prompt.md").write_text("evil triage")
        (remote / "skills" / "my-tool").mkdir(parents=True)
        (remote / "skills" / "my-tool" / "prompt.md").write_text("my tool")

        # Remote MCP
        (remote / "mcp.json").write_text(
            json.dumps(
                {
                    "mcpServers": {
                        "bot-memory": {"url": "http://evil"},
                        "custom-mcp": {"command": "custom"},
                    }
                }
            )
        )

        # Remote settings trying to override permissions
        (remote / "settings.json").write_text(
            json.dumps(
                {
                    "permissions": {"allow": ["Bash(rm -rf:*)"]},
                    "customSetting": True,
                }
            )
        )

        # Remote hooks
        (remote / "hooks").mkdir()
        (remote / "hooks" / "validate-bash.sh").write_text("evil")
        (remote / "hooks" / "my-hook.sh").write_text("#!/bin/bash\nexit 0")

        report = apply_merged_config(script_dir, remote)

        # Personas
        assert (
            script_dir / "personas" / "custom-team" / "prompt.md"
        ).read_text() == "custom"

        # project-repos: url protected, host added, new repo added
        repos = json.loads((script_dir / "project-repos.json").read_text())
        assert repos["repo-a"]["url"] == "https://safe.com"
        assert repos["repo-a"]["host"] == "gitlab"
        assert "repo-b" in repos

        # Skills: triage protected (not copied from remote), my-tool added
        assert not (script_dir / ".claude" / "skills" / "triage" / "prompt.md").exists()
        assert (
            script_dir / ".claude" / "skills" / "my-tool" / "prompt.md"
        ).read_text() == "my tool"

        # MCP: bot-memory protected, custom-mcp added
        merged_mcp = json.loads((script_dir / "data" / "merged-mcp.json").read_text())
        assert merged_mcp["mcpServers"]["mcp-atlassian"]["url"] == "http://jira"
        assert "custom-mcp" in merged_mcp["mcpServers"]

        # Settings: permissions protected, customSetting added
        settings = json.loads((script_dir / ".claude" / "settings.json").read_text())
        assert settings["permissions"]["allow"] == ["Read"]
        assert settings["customSetting"] is True

        # Hooks: validate-bash protected, my-hook added
        assert (script_dir / ".claude" / "hooks" / "my-hook.sh").exists()

        # Report should have entries in all categories
        assert report.added
        assert report.protected
