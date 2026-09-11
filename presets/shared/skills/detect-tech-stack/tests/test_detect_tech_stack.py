import json
import subprocess

from detect_tech_stack import detect


class TestNodeReactPatternfly:
    def test_react_detected(self, tmp_path):
        (tmp_path / "package.json").write_text(json.dumps({"dependencies": {"react": "^18.0.0"}}))
        result = detect(str(tmp_path))
        assert "node" in result["stack"]
        assert "react" in result["stack"]
        assert "node" in result["envs"]
        assert "browser" in result["envs"]
        assert "frontend" in result["personas"]

    def test_patternfly_detected(self, tmp_path):
        (tmp_path / "package.json").write_text(json.dumps({"devDependencies": {"@patternfly/react-core": "^5.0.0"}}))
        result = detect(str(tmp_path))
        assert "patternfly" in result["stack"]
        assert "patternfly-mcp" in result["envs"]

    def test_node_only_no_react(self, tmp_path):
        (tmp_path / "package.json").write_text(json.dumps({"dependencies": {"express": "^4.0.0"}}))
        result = detect(str(tmp_path))
        assert "node" in result["stack"]
        assert "react" not in result["stack"]
        assert "node" in result["envs"]

    def test_malformed_package_json(self, tmp_path):
        # "not json" with no quotes is invalid JSON and triggers JSONDecodeError
        (tmp_path / "package.json").write_text("not json")
        result = detect(str(tmp_path))
        assert "node" not in result["stack"]
        assert result["stack"] == []


class TestTypescript:
    def test_tsconfig_detected(self, tmp_path):
        (tmp_path / "tsconfig.json").write_text("{}")
        (tmp_path / "package.json").write_text(json.dumps({"dependencies": {}}))
        result = detect(str(tmp_path))
        assert "typescript" in result["stack"]


class TestGo:
    def test_go_basic(self, tmp_path):
        (tmp_path / "go.mod").write_text("module example.com/myapp\n\ngo 1.21\n")
        result = detect(str(tmp_path))
        assert "go" in result["stack"]
        assert "backend" in result["personas"]
        assert "go" in result["envs"]

    def test_go_operator_sdk(self, tmp_path):
        (tmp_path / "go.mod").write_text("module example.com/myapp\n\nrequire operator-sdk v1.0.0\n")
        result = detect(str(tmp_path))
        assert "go" in result["stack"]
        assert "operator" in result["stack"]
        assert "operator" in result["personas"]

    def test_go_controller_runtime(self, tmp_path):
        (tmp_path / "go.mod").write_text("module example.com/myapp\n\nrequire sigs.k8s.io/controller-runtime v0.15.0\n")
        result = detect(str(tmp_path))
        assert "go" in result["stack"]
        assert "operator" in result["stack"]


class TestPython:
    def test_requirements_txt(self, tmp_path):
        (tmp_path / "requirements.txt").write_text("flask==2.0\n")
        result = detect(str(tmp_path))
        assert "python" in result["stack"]

    def test_pyproject_toml(self, tmp_path):
        (tmp_path / "pyproject.toml").write_text("[project]\nname = 'myapp'\n")
        result = detect(str(tmp_path))
        assert "python" in result["stack"]

    def test_django_detected(self, tmp_path):
        (tmp_path / "requirements.txt").write_text("Django==4.0\n")
        result = detect(str(tmp_path))
        assert "django" in result["stack"]
        assert "backend" in result["personas"]


class TestTooling:
    def test_dockerfile_only_is_tooling(self, tmp_path):
        (tmp_path / "Dockerfile").write_text("FROM python:3.12\n")
        result = detect(str(tmp_path))
        assert "tooling" in result["stack"]
        assert "tooling" in result["personas"]

    def test_dockerfile_with_package_json_not_tooling(self, tmp_path):
        (tmp_path / "Dockerfile").write_text("FROM node:18\n")
        # needs a non-empty dict so bool(pkg_json) is True
        (tmp_path / "package.json").write_text(json.dumps({"name": "test"}))
        result = detect(str(tmp_path))
        assert "tooling" not in result["stack"]


class TestConfigHeavy:
    def test_yaml_heavy_no_app_code(self, tmp_path):
        for name in ("a.yaml", "b.yaml", "c.yaml"):
            (tmp_path / name).write_text("key: value\n")
        (tmp_path / "readme.txt").write_text("hello\n")
        result = detect(str(tmp_path))
        assert "config" in result["stack"]
        assert "config" in result["personas"]

    def test_yaml_heavy_with_app_code_not_config(self, tmp_path):
        for name in ("a.yaml", "b.yaml", "c.yaml"):
            (tmp_path / name).write_text("key: value\n")
        # needs a non-empty dict so bool(pkg_json) is True
        (tmp_path / "package.json").write_text(json.dumps({"name": "test"}))
        result = detect(str(tmp_path))
        assert "config" not in result["stack"]

    def test_fifty_percent_yaml_not_config(self, tmp_path):
        (tmp_path / "a.yaml").write_text("key: value\n")
        (tmp_path / "readme.txt").write_text("hello\n")
        result = detect(str(tmp_path))
        assert "config" not in result["stack"]


class TestUnsupported:
    def test_java_pom(self, tmp_path):
        (tmp_path / "pom.xml").write_text("<project/>\n")
        result = detect(str(tmp_path))
        assert "java" in result["stack"]
        assert "java" in result["unsupported_stacks"]
        assert result["needs_team_review"] is True

    def test_rust_cargo(self, tmp_path):
        (tmp_path / "Cargo.toml").write_text("[package]\nname = 'myapp'\n")
        result = detect(str(tmp_path))
        assert "rust" in result["unsupported_stacks"]

    def test_ruby_gemfile(self, tmp_path):
        (tmp_path / "Gemfile").write_text("source 'https://rubygems.org'\n")
        result = detect(str(tmp_path))
        assert "ruby" in result["unsupported_stacks"]

    def test_no_unsupported_key_when_clean(self, tmp_path):
        (tmp_path / "package.json").write_text(json.dumps({"dependencies": {"react": "^18.0.0"}}))
        result = detect(str(tmp_path))
        assert "unsupported_stacks" not in result


class TestEmptyRepo:
    def test_empty_dir(self, tmp_path):
        result = detect(str(tmp_path))
        assert result["stack"] == []
        assert "tooling" in result["personas"]


class TestMultiStack:
    def test_react_typescript_go(self, tmp_path):
        (tmp_path / "package.json").write_text(json.dumps({"dependencies": {"react": "^18.0.0"}}))
        (tmp_path / "tsconfig.json").write_text("{}")
        (tmp_path / "go.mod").write_text("module example.com/myapp\n\ngo 1.21\n")
        result = detect(str(tmp_path))
        assert "node" in result["stack"]
        assert "react" in result["stack"]
        assert "typescript" in result["stack"]
        assert "go" in result["stack"]


class TestDefaultBranch:
    def test_non_git_defaults_to_main(self, tmp_path):
        result = detect(str(tmp_path))
        assert result["target_branch"] == "main"

    def test_detects_main_from_refs(self, tmp_path):
        subprocess.run(["git", "init"], cwd=tmp_path, capture_output=True, check=True)
        refs_dir = tmp_path / ".git" / "refs" / "remotes" / "origin"
        refs_dir.mkdir(parents=True)
        (refs_dir / "HEAD").write_text("ref: refs/remotes/origin/main\n")
        (refs_dir / "main").write_text("0" * 40 + "\n")
        result = detect(str(tmp_path))
        assert result["target_branch"] == "main"

    def test_detects_master_from_refs(self, tmp_path):
        subprocess.run(["git", "init"], cwd=tmp_path, capture_output=True, check=True)
        refs_dir = tmp_path / ".git" / "refs" / "remotes" / "origin"
        refs_dir.mkdir(parents=True)
        (refs_dir / "master").write_text("0" * 40 + "\n")
        result = detect(str(tmp_path))
        assert result["target_branch"] == "master"


class TestSymlinkProtection:
    def test_symlinked_file_excluded_from_yaml_count(self, tmp_path):
        real_file = tmp_path / "real.yaml"
        real_file.write_text("key: value\n")
        symlink = tmp_path / "link.yaml"
        symlink.symlink_to(real_file)
        (tmp_path / "other.txt").write_text("hello\n")
        result = detect(str(tmp_path))
        # Symlinked yaml should be excluded from count
        # Without symlink protection, yaml_count would be 2 out of 3 files (>50%)
        # With protection, symlink is excluded from both yaml_count and total
        assert "config" not in result["stack"]

    def test_symlinked_go_mod_not_read(self, tmp_path):
        real = tmp_path / "real_go_mod"
        real.write_text("module x\nrequire operator-sdk v1.0.0\n")
        (tmp_path / "go.mod").symlink_to(real)
        result = detect(str(tmp_path))
        # _file_contains should skip symlinked go.mod
        assert "operator" not in result["stack"]


class TestVisibilityValidation:
    def test_crafted_owner_repo_returns_unknown(self, tmp_path):
        subprocess.run(["git", "init"], cwd=tmp_path, capture_output=True, check=True)
        subprocess.run(
            ["git", "remote", "add", "origin", "https://github.com/../../../api/v3/repos/evil"],
            cwd=tmp_path,
            capture_output=True,
            check=True,
        )
        result = detect(str(tmp_path))
        assert result["visibility"] == "unknown"


class TestReturnShape:
    def test_required_keys(self, tmp_path):
        result = detect(str(tmp_path))
        for key in ("stack", "envs", "personas", "target_branch", "has_dockerfile", "visibility", "note"):
            assert key in result, f"missing key: {key}"
