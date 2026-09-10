"""Guard: the integration marker must not leak onto unit tests in a mixed session."""

import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent


def test_integration_marker_does_not_apply_to_unit_tests_in_mixed_collection():
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "pytest",
            "tests/integration",
            "tests/test_merge.py",
            "--collect-only",
            "-q",
            "-m",
            "integration",
            "-p",
            "no:cacheprovider",
            "-p",
            "no:cov",
        ],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    output = result.stdout + result.stderr
    assert result.returncode == 0, output
    assert "test_git_proxy_integration.py" in output
    assert "test_merge.py" not in output
