"""Integration tests for coverage workflows."""

import sys
from pathlib import Path
from unittest.mock import patch


sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

from coverage_operations import CoverageOperations, OperationStatus


def test_workflow_dry_run():
    """Test dry-run mode."""
    ops = CoverageOperations(threshold=70.0, dry_run=True)
    result = ops.execute_workflow()

    assert result.success is True
    # All operations should succeed in dry-run
    for op in result.operations:
        assert "[DRY RUN]" in op.message


def test_workflow_no_coverage_tool():
    """Test workflow when no coverage tool detected."""
    # Mock Path.exists to return False for ALL files
    # AND mock Path.open to prevent real file access
    with (
        patch("pathlib.Path.exists", return_value=False),
        patch("builtins.open", side_effect=FileNotFoundError("No config files")),
    ):
        ops = CoverageOperations(threshold=70.0, dry_run=False)
        result = ops.execute_workflow()

    assert result.success is True  # Doesn't fail, but skips
    detect_op = result.operations[0]
    assert detect_op.operation == "detect_repo_type"
    assert detect_op.status == OperationStatus.SKIPPED
