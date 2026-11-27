"""Validate the review queue, related repositories, and direct Markdown links."""

from __future__ import annotations

import re
from pathlib import Path
from urllib.parse import unquote, urlsplit

import yaml

AGENT_DIR = Path(__file__).resolve().parents[2]
CONFIG_PATH = AGENT_DIR / "review-context.yaml"
DIMENSIONS_PATH = AGENT_DIR / "skills" / "dimensional-review" / "dimensions.yaml"
_ID = re.compile(r"^[a-z0-9][a-z0-9-]*$")
_REPO_PART = re.compile(r"^[A-Za-z0-9_.-]+$")
_ENV_REFERENCE = re.compile(r"^\$\{([A-Z_][A-Z0-9_]*)\}$")


class ReviewConfigError(ValueError):
    pass


def environment_variable_name(value: object) -> str | None:
    """Return the variable name from an explicit ${VARIABLE} reference."""
    if not isinstance(value, str):
        return None
    match = _ENV_REFERENCE.fullmatch(value)
    return match.group(1) if match else None


def github_repo_url(url: str) -> str:
    """Return owner/repo from an HTTPS GitHub repository URL."""
    parsed = urlsplit(url)
    parts = parsed.path.strip("/").split("/")
    if (
        parsed.scheme != "https"
        or parsed.netloc.lower() != "github.com"
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
        or len(parts) != 2
        or any(not _REPO_PART.fullmatch(part) for part in parts)
        or parts[1].removesuffix(".git") in ("", ".", "..")
    ):
        raise ReviewConfigError(f"Expected a plain GitHub repository URL: {url}")
    return f"{parts[0]}/{parts[1].removesuffix('.git')}"


def github_markdown_url(url: str) -> tuple[str, str, str]:
    """Return (owner/repo, ref, path) for a direct GitHub Markdown file link.

    A branch containing "/" is ambiguous in a blob URL; use a commit permalink
    for that case.
    """
    parsed = urlsplit(url)
    parts = [unquote(part) for part in parsed.path.strip("/").split("/")]
    if (
        parsed.scheme != "https"
        or parsed.netloc.lower() != "github.com"
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
        or len(parts) < 5
        or parts[2] != "blob"
        or not _REPO_PART.fullmatch(parts[0])
        or not _REPO_PART.fullmatch(parts[1])
        or not _REPO_PART.fullmatch(parts[3])
        or parts[3] in (".", "..")
        or any("/" in part or "\\" in part for part in parts)
        or any(part in ("", ".", "..") for part in parts[4:])
        or not parts[-1].lower().endswith(".md")
    ):
        raise ReviewConfigError(f"Expected a direct GitHub .md file URL: {url}")
    return f"{parts[0]}/{parts[1]}", parts[3], "/".join(parts[4:])


def github_recipe_url(url: str) -> tuple[str, str, str]:
    """Return (owner/repo, ref, path) for a direct GitHub Goose recipe URL."""
    parsed = urlsplit(url)
    parts = [unquote(part) for part in parsed.path.strip("/").split("/")]
    if (
        parsed.scheme != "https"
        or parsed.netloc.lower() != "github.com"
        or parsed.username or parsed.password or parsed.query or parsed.fragment
        or len(parts) < 5 or parts[2] != "blob"
        or any(not _REPO_PART.fullmatch(part) for part in parts[:2])
        or not _REPO_PART.fullmatch(parts[3])
        or any(part in (".", "..") for part in (parts[0], parts[1], parts[3]))
        or any(part in ("", ".", "..") or "/" in part or "\\" in part for part in parts[4:])
        or not parts[-1].lower().endswith((".yaml", ".yml"))
    ):
        raise ReviewConfigError(f"Expected a direct GitHub Goose YAML URL: {url}")
    return f"{parts[0]}/{parts[1]}", parts[3], "/".join(parts[4:])


def _entries(value: object, field: str) -> list[dict]:
    if not isinstance(value, list):
        raise ReviewConfigError(f"{field} must be a list")
    entries: list[dict] = []
    ids: set[str] = set()
    for item in value:
        if not isinstance(item, dict):
            raise ReviewConfigError(f"{field} entries must be objects")
        ident = item.get("id")
        if not isinstance(ident, str) or not _ID.fullmatch(ident):
            raise ReviewConfigError(f"{field} entry id must be lowercase letters, digits, or hyphens")
        if ident in ids:
            raise ReviewConfigError(f"Duplicate {field} id: {ident}")
        ids.add(ident)
        entries.append(item)
    return entries


def load_config(path: Path = CONFIG_PATH) -> dict:
    if not path.is_file():
        raise ReviewConfigError(f"Missing review context config: {path}")
    try:
        data = yaml.safe_load(path.read_text())
    except yaml.YAMLError as exc:
        raise ReviewConfigError(f"Invalid YAML in {path}: {exc}") from exc
    if not isinstance(data, dict):
        raise ReviewConfigError("review-context.yaml must be a mapping")
    label = data.get("review_label")
    if not isinstance(label, str) or not label.strip():
        raise ReviewConfigError("review_label must be a non-empty GitHub label")
    repositories = data.get("repositories")
    if not isinstance(repositories, dict):
        raise ReviewConfigError("repositories must be a mapping")
    dimension_names: set[str] | None = None
    for repo_key, context in repositories.items():
        if not isinstance(repo_key, str) or not repo_key:
            raise ReviewConfigError("repository keys must be non-empty strings")
        if not isinstance(context, dict):
            raise ReviewConfigError(f"repositories.{repo_key} must be a mapping")
        if context.get("format", "standard") not in ("standard", "custom"):
            raise ReviewConfigError(f"repositories.{repo_key}.format must be standard or custom")
        jira = context.get("jira")
        if jira is not None:
            if not isinstance(jira, dict):
                raise ReviewConfigError(f"repositories.{repo_key}.jira must be a mapping")
            if not isinstance(jira.get("team_field"), str) or not re.fullmatch(
                    r"customfield_[0-9]+", jira["team_field"]):
                raise ReviewConfigError(
                    f"repositories.{repo_key}.jira.team_field must be a Jira custom-field ID"
                )
            profiles = jira.get("profiles")
            if not isinstance(profiles, dict) or not profiles:
                raise ReviewConfigError(f"repositories.{repo_key}.jira.profiles must be a non-empty mapping")
            target_repositories: set[str] = set()
            for profile_name, profile in profiles.items():
                if not isinstance(profile_name, str) or not _ID.fullmatch(profile_name):
                    raise ReviewConfigError(f"repositories.{repo_key}.jira profile names must be lowercase IDs")
                if not isinstance(profile, dict):
                    raise ReviewConfigError(f"repositories.{repo_key}.jira.profiles.{profile_name} must be a mapping")
                target_repository = profile.get("target_repository")
                if (not isinstance(target_repository, str)
                        or len(target_repository.split("/")) != 2
                        or any(not _REPO_PART.fullmatch(part) for part in target_repository.split("/"))):
                    raise ReviewConfigError(
                        f"repositories.{repo_key}.jira.profiles.{profile_name}.target_repository must be owner/repo"
                    )
                if target_repository in target_repositories:
                    raise ReviewConfigError(f"Jira target repository is duplicated: {target_repository}")
                target_repositories.add(target_repository)
                for field in ("project_env", "team_id_env", "team_name_env", "labels_env"):
                    env_name = profile.get(field)
                    if environment_variable_name(env_name) is None:
                        raise ReviewConfigError(
                            f"repositories.{repo_key}.jira.profiles.{profile_name}.{field} "
                            "must use a ${UPPERCASE_ENVIRONMENT_VARIABLE} reference"
                        )
                if ("component_id_env" in profile
                        and environment_variable_name(profile["component_id_env"]) is None):
                    raise ReviewConfigError(
                        f"repositories.{repo_key}.jira.profiles.{profile_name}.component_id_env "
                        "must use a ${UPPERCASE_ENVIRONMENT_VARIABLE} reference"
                    )
        if context.get("format") == "custom" and not context.get("skills"):
            raise ReviewConfigError(f"repositories.{repo_key}.format custom needs at least one skill")
        if "skills" in context:
            skills = context["skills"]
            if not isinstance(skills, list) or any(not isinstance(name, str) or not _ID.fullmatch(name) for name in skills):
                raise ReviewConfigError(f"repositories.{repo_key}.skills must be a list of dimension names")
            if len(skills) != len(set(skills)):
                raise ReviewConfigError(f"repositories.{repo_key}.skills contains duplicates")
            if skills and dimension_names is None:
                try:
                    catalog = yaml.safe_load(DIMENSIONS_PATH.read_text())
                    dimension_names = {item["name"] for item in catalog["dimensions"]}
                except (OSError, yaml.YAMLError, TypeError, KeyError) as exc:
                    raise ReviewConfigError("Cannot read dimensional review catalog") from exc
            unknown = set(skills) - (dimension_names or set())
            if unknown:
                raise ReviewConfigError(f"repositories.{repo_key}.skills has unknown dimensions: {', '.join(sorted(unknown))}")
        for related in _entries(context.get("related", []), f"{repo_key}.related"):
            url = related.get("url")
            relationship = related.get("relationship")
            if not isinstance(url, str):
                raise ReviewConfigError(f"{repo_key}.related.{related['id']} needs a URL")
            github_repo_url(url)
            if not isinstance(relationship, str) or not relationship.strip():
                raise ReviewConfigError(f"{repo_key}.related.{related['id']} needs a relationship")
        for doc in _entries(context.get("docs", []), f"{repo_key}.docs"):
            url = doc.get("url")
            if not isinstance(url, str):
                raise ReviewConfigError(f"{repo_key}.docs.{doc['id']} needs a URL")
            github_markdown_url(url)
    return data
