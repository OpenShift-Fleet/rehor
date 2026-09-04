"""Tests that manifest skill references and skill imports resolve at runtime.

Catches bugs where:
- manifest.yaml lists skills under the wrong key (shared_skills vs provides.skills)
- skill scripts import modules that won't be on sys.path at runtime
- shared helper modules referenced by skills are missing from .claude/skills/

See docs/presets-design.md (install_skills) and docs/presets/workflows.md for the
runtime resolution model: install_skills() copies skill *directories* from
presets/shared/skills/ and <workflow>/skills/ into .claude/skills/. Loose .py
files in .claude/skills/ (jira_mcp.py, memory_mcp.py, etc.) are permanent shared
helpers, not copied by install_skills.
"""

import importlib.util
import re
from pathlib import Path

import pytest
import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
WORKFLOWS_DIR = REPO_ROOT / "presets" / "workflows"
SHARED_SKILLS_DIR = REPO_ROOT / "presets" / "shared" / "skills"
CLAUDE_SKILLS_DIR = REPO_ROOT / ".claude" / "skills"

_SYS_PATH_RE = re.compile(r"^sys\.path\.insert\(0,\s*os\.path\.join\(")
_FROM_IMPORT_RE = re.compile(r"^from\s+(\w+)\s+import\s+")
_SIBLING_RE = re.compile(
    r"sys\.path\.insert\(0,\s*os\.path\.join\("
    r'os\.path\.dirname\(__file__\),\s*"\.\."\s*,\s*"([^"]+)"\)\)'
)


def _discover_manifests():
    return sorted(WORKFLOWS_DIR.glob("*/manifest.yaml"))


def _load(path):
    return yaml.safe_load(path.read_text())


def _is_stdlib_or_installed(module_name):
    try:
        return importlib.util.find_spec(module_name) is not None
    except (ModuleNotFoundError, ValueError):
        return False


def _runtime_imports(py_file: Path):
    """Return (module_name, line_no) pairs for imports after sys.path.insert."""
    lines = py_file.read_text().splitlines()
    after_sys_path = False
    siblings = set()
    results = []

    for i, line in enumerate(lines, 1):
        stripped = line.strip()
        if _SYS_PATH_RE.match(stripped):
            after_sys_path = True
            m = _SIBLING_RE.match(stripped)
            if m:
                siblings.add(m.group(1))
            continue

        if after_sys_path:
            m = _FROM_IMPORT_RE.match(stripped)
            if m:
                results.append((m.group(1), i, siblings.copy()))

    return results


class TestManifestSkillPaths:
    """Validate that every skill referenced in manifests exists on disk."""

    @pytest.fixture(params=_discover_manifests(), ids=lambda p: p.parent.name)
    def manifest_path(self, request):
        return request.param

    def test_shared_skills_dirs_exist(self, manifest_path):
        data = _load(manifest_path)
        wf_name = manifest_path.parent.name
        missing = []
        for skill in data.get("shared_skills", []):
            if not (SHARED_SKILLS_DIR / skill).is_dir():
                missing.append(skill)
        assert not missing, (
            f"{wf_name}/manifest.yaml: shared_skills entries not found in presets/shared/skills/: {missing}"
        )

    @pytest.mark.xfail(
        reason="jira-sprint and jira-kanban declare triage/new-work skills that don't exist yet in upstream master",
        strict=False,
    )
    def test_provides_skills_dirs_exist(self, manifest_path):
        data = _load(manifest_path)
        wf_name = manifest_path.parent.name
        skills_dir = manifest_path.parent / "skills"
        missing = []
        for skill in data.get("provides", {}).get("skills", []):
            if not (skills_dir / skill).is_dir():
                missing.append(skill)
        assert not missing, (
            f"{wf_name}/manifest.yaml: provides.skills entries not found in {wf_name}/skills/: {missing}"
        )


def _collect_skill_py_files():
    """Collect (manifest_path, skill_name, py_file) for parametrization."""
    items = []
    for manifest_path in _discover_manifests():
        data = _load(manifest_path)
        skills_dir = manifest_path.parent / "skills"
        for skill_name in data.get("provides", {}).get("skills", []):
            skill_dir = skills_dir / skill_name
            if not skill_dir.is_dir():
                continue
            for py_file in sorted(skill_dir.glob("*.py")):
                if py_file.name.startswith("test_"):
                    continue
                items.append((manifest_path, skill_name, py_file))
    return items


_SKILL_PY_FILES = _collect_skill_py_files()


@pytest.mark.skipif(not _SKILL_PY_FILES, reason="no skill python files found")
class TestSkillImportResolution:
    """Verify that runtime imports in skill scripts will resolve after install_skills()."""

    @pytest.fixture(
        params=_SKILL_PY_FILES,
        ids=lambda t: f"{t[0].parent.name}/{t[1]}/{t[2].name}",
    )
    def skill_file(self, request):
        return request.param

    def test_imports_resolve(self, skill_file):
        manifest_path, skill_name, py_file = skill_file
        data = _load(manifest_path)

        all_provided = set(data.get("provides", {}).get("skills", []))

        for module_name, line_no, siblings in _runtime_imports(py_file):
            if _is_stdlib_or_installed(module_name):
                continue

            found = False
            locations_checked = []

            shared_helper = CLAUDE_SKILLS_DIR / f"{module_name}.py"
            locations_checked.append(str(shared_helper.relative_to(REPO_ROOT)))
            if shared_helper.is_file():
                found = True

            if not found:
                for sibling_dir_name in siblings:
                    sibling_dir = manifest_path.parent / "skills" / sibling_dir_name
                    candidate = sibling_dir / f"{module_name}.py"
                    locations_checked.append(str(candidate.relative_to(REPO_ROOT)))
                    if candidate.is_file():  # noqa: SIM102
                        if sibling_dir_name in all_provided:
                            found = True
                            break

            if not found:
                for other_skill in all_provided:
                    other_dir = manifest_path.parent / "skills" / other_skill
                    candidate = other_dir / f"{module_name}.py"
                    if candidate.is_file():
                        locations_checked.append(str(candidate.relative_to(REPO_ROOT)))
                        found = True
                        break

            assert found, (
                f"{py_file.relative_to(REPO_ROOT)}:{line_no}: "
                f"'from {module_name} import ...' won't resolve at runtime. "
                f"Checked: {', '.join(locations_checked)}. "
                f"Add {module_name}.py to .claude/skills/ as a shared helper, "
                f"or ensure the source skill dir is in the manifest."
            )
