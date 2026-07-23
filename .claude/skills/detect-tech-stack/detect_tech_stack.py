#!/usr/bin/env python3
"""Detect tech stack from a cloned repo and suggest env presets + personas.

Usage:
    python3 detect_tech_stack.py <repo_path>

Output: JSON with stack tags, suggested env presets, suggested personas,
default branch, Dockerfile presence, and visibility.
"""

import json
import os
import subprocess
import sys
from pathlib import Path


def _read_json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return {}


def _file_contains(path, pattern):
    try:
        return pattern.lower() in Path(path).read_text(errors="ignore").lower()
    except OSError:
        return False


def _detect_default_branch(repo_path):
    try:
        result = subprocess.run(
            ["git", "symbolic-ref", "refs/remotes/origin/HEAD"],
            capture_output=True,
            text=True,
            cwd=repo_path,
        )
        if result.returncode == 0:
            return result.stdout.strip().split("/")[-1]
    except OSError:
        pass
    for candidate in ("main", "master"):
        branch_ref = Path(repo_path) / ".git" / "refs" / "remotes" / "origin" / candidate
        if branch_ref.exists():
            return candidate
    return "main"


def _detect_visibility(repo_path):
    try:
        result = subprocess.run(
            ["git", "remote", "get-url", "origin"],
            capture_output=True,
            text=True,
            cwd=repo_path,
        )
        remote_url = result.stdout.strip() if result.returncode == 0 else ""
    except OSError:
        return "unknown"

    if not remote_url:
        return "unknown"

    if "github.com" in remote_url:
        owner_repo = remote_url.split("github.com")[-1].strip(":/").removesuffix(".git")
        try:
            check = subprocess.run(
                ["gh", "api", f"repos/{owner_repo}", "--jq", ".visibility"],
                capture_output=True,
                text=True,
                timeout=10,
            )
            if check.returncode == 0:
                return check.stdout.strip()
        except (OSError, subprocess.TimeoutExpired):
            pass

    return "unknown"


def detect(repo_path):
    root = Path(repo_path)
    stack = []
    envs = set()
    personas = set()

    pkg_json = _read_json(root / "package.json")
    all_deps = {**pkg_json.get("dependencies", {}), **pkg_json.get("devDependencies", {})}

    if pkg_json:
        stack.append("node")
        envs.add("node")
        if any(k.startswith("react") for k in all_deps):
            stack.append("react")
            personas.add("frontend")
            envs.add("browser")
        if any("patternfly" in k for k in all_deps):
            stack.append("patternfly")
            envs.add("patternfly-mcp")

    if (root / "tsconfig.json").exists():
        stack.append("typescript")

    if (root / "go.mod").exists():
        stack.append("go")
        envs.add("go")
        if _file_contains(root / "go.mod", "operator-sdk") or _file_contains(
            root / "go.mod", "sigs.k8s.io/controller-runtime"
        ):
            stack.append("operator")
            personas.add("operator")
        else:
            personas.add("backend")

    for req_file in ("Pipfile", "requirements.txt", "pyproject.toml"):
        if (root / req_file).exists():
            stack.append("python")
            if _file_contains(root / req_file, "django"):
                stack.append("django")
                personas.add("backend")
            break

    has_dockerfile = any(root.glob("Dockerfile*"))
    has_app_code = (
        bool(pkg_json)
        or (root / "go.mod").exists()
        or any((root / f).exists() for f in ("Pipfile", "requirements.txt", "pyproject.toml"))
    )

    if has_dockerfile and not has_app_code:
        stack.append("tooling")
        personas.add("tooling")

    yaml_count = len(list(root.glob("**/*.yaml"))) + len(list(root.glob("**/*.yml")))
    total_files = sum(1 for _ in root.rglob("*") if _.is_file() and ".git" not in _.parts)
    if total_files > 0 and yaml_count / total_files > 0.5 and not has_app_code:
        stack.append("config")
        personas.add("config")

    unsupported = []
    if (root / "pom.xml").exists() or (root / "build.gradle").exists():
        stack.append("java")
        unsupported.append("java")
    if (root / "Cargo.toml").exists():
        stack.append("rust")
        unsupported.append("rust")
    if (root / "Gemfile").exists():
        stack.append("ruby")
        unsupported.append("ruby")

    if not personas:
        if has_app_code:
            personas.add("backend")
        else:
            personas.add("tooling")

    result = {
        "stack": list(dict.fromkeys(stack)),
        "suggested_envs": sorted(envs),
        "suggested_personas": sorted(personas),
        "default_branch": _detect_default_branch(repo_path),
        "has_dockerfile": has_dockerfile,
        "visibility": _detect_visibility(repo_path),
        "note": "Suggestions based on file markers. Review and adjust before use.",
    }

    if unsupported:
        result["unsupported_stacks"] = unsupported
        result["needs_team_review"] = True

    return result


def main():
    if len(sys.argv) < 2:
        print("Usage: detect_tech_stack.py <repo_path>", file=sys.stderr)
        sys.exit(1)

    repo_path = sys.argv[1]
    if not os.path.isdir(repo_path):
        print(json.dumps({"error": f"Not a directory: {repo_path}"}))
        sys.exit(1)

    result = detect(repo_path)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
