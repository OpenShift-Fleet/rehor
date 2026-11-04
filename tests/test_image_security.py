"""Security floors from the November 2026 ACS report.

The memory image builds outside the workspace using its own frozen lockfile.
Checking only the root lock would miss vulnerabilities in the deployed server.
"""

import re
import tomllib
from pathlib import Path

import pytest
from packaging.version import Version

ROOT = Path(__file__).resolve().parents[1]
COMMON_FLOORS = {
    "anyio": "4.14.2",
    "authlib": "1.9.1",
    "certifi": "2026.10.19",
    "cryptography": "50.0.0",
    "fastmcp": "3.4.10",
    "filelock": "4.2.1",
    "idna": "3.15",
    "mcp": "1.30.0",
    "opentelemetry-api": "1.45.1",
    "pydantic-settings": "2.14.2",
    "pyjwt": "2.15.0",
    "python-multipart": "0.0.31",
    "sentence-transformers": "5.6.0",
    "starlette": "1.3.1",
    "torch": "2.13.0",
    "transformers": "5.10.4",
    "urllib3": "2.8.0",
}


@pytest.mark.parametrize("lockfile", ["uv.lock", "memory-server/uv.lock"])
def test_frozen_image_dependencies_have_security_fixes(lockfile):
    data = tomllib.loads((ROOT / lockfile).read_text())
    packages = {p["name"]: p["version"] for p in data["package"]}
    floors = dict(COMMON_FLOORS)
    if lockfile == "uv.lock":
        floors["claude-agent-sdk"] = "0.2.121"
    for name, floor in floors.items():
        assert Version(packages[name]) >= Version(floor), f"{lockfile}: {name} must be >= {floor}"


def test_runner_builds_kustomize_with_current_go_toolchain():
    recipe = (ROOT / "Dockerfile.runner").read_text()
    assert "go install sigs.k8s.io/kustomize/kustomize/v5@v5.7.1" in recipe
    assert "COPY --from=executor-client-builder /tmp/kustomize /usr/local/bin/kustomize" in recipe
    assert "kustomize_v5.7.1_linux_" not in recipe


@pytest.mark.parametrize(
    ("recipe", "update"),
    [
        ("Dockerfile", "upgrade -y"),
        ("Dockerfile.runner", "upgrade -y"),
        ("proxy/Dockerfile", "upgrade -y"),
        ("memory-server/Dockerfile", "microdnf upgrade -y"),
    ],
)
def test_runtime_base_packages_are_updated(recipe, update):
    runtime_stage = (ROOT / recipe).read_text().rsplit("\nFROM ", 1)[-1]
    assert update in runtime_stage


def test_copied_node_libraries_are_patched_in_builder():
    recipe = (ROOT / "Dockerfile.runner").read_text()
    node_builder = recipe.split("AS executor-client-builder", 1)[0]
    assert "upgrade -y" in node_builder


@pytest.mark.parametrize(
    "recipe", ["Dockerfile", "Dockerfile.runner", "Makefile", "docker-compose.yml", "presets/envs/go/install.sh"]
)
def test_default_go_toolchains_are_supported_patched_releases(recipe):
    versions = re.findall(r"1\.\d+\.\d+", (ROOT / recipe).read_text())
    assert "1.26.10" in versions
    assert "1.27.3" in versions
    assert "1.24.13" not in versions


def test_proxy_uses_security_constraints():
    recipe = (ROOT / "proxy/Dockerfile").read_text()
    assert "-c /tmp/mcp-constraints.txt mcp-atlassian==0.23.1" in recipe
    constraints = (ROOT / "proxy/constraints.txt").read_text().splitlines()
    for name in ("authlib", "certifi", "pyjwt", "anyio", "cryptography"):
        assert f"{name}>={COMMON_FLOORS[name]}" in constraints
