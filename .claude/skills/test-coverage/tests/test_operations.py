"""Unit tests for coverage operations."""

import json
from pathlib import Path
from unittest.mock import MagicMock, mock_open, patch

import pytest

import sys

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

from coverage_operations import (
    CoverageData,
    CoverageOperations,
    DiffCoverageData,
    FileCoverage,
    FileDiffCoverage,
    OperationStatus,
    RepoType,
)


@pytest.fixture
def ops():
    """Create CoverageOperations instance."""
    return CoverageOperations(threshold=70.0, dry_run=False)


@pytest.fixture
def ops_dry_run():
    """Create CoverageOperations instance in dry-run mode."""
    return CoverageOperations(threshold=70.0, dry_run=True)


# Test: Detect Repository Type


def test_detect_repo_type_jest(ops):
    """Test detection of Jest framework."""
    pkg_json = json.dumps({"devDependencies": {"jest": "^29.0.0"}})

    with (
        patch("pathlib.Path.exists", return_value=True),
        patch("builtins.open", mock_open(read_data=pkg_json)),
    ):
        result = ops.detect_repo_type()

    assert result.status == OperationStatus.SUCCESS
    assert ops.repo_type == RepoType.JEST
    assert "Jest" in result.message


def test_detect_repo_type_vitest(ops):
    """Test detection of Vitest framework."""
    pkg_json = json.dumps({"devDependencies": {"vitest": "^1.0.0"}})

    with (
        patch("pathlib.Path.exists", return_value=True),
        patch("builtins.open", mock_open(read_data=pkg_json)),
    ):
        result = ops.detect_repo_type()

    assert result.status == OperationStatus.SUCCESS
    assert ops.repo_type == RepoType.VITEST
    assert "Vitest" in result.message


def test_detect_repo_type_pytest(ops):
    """Test detection of pytest framework."""
    with patch("scripts.coverage_operations.Path") as mock_path_class:

        def path_side_effect(path_str):
            p = MagicMock()
            p.exists.return_value = path_str == "pyproject.toml"
            return p

        mock_path_class.side_effect = path_side_effect
        result = ops.detect_repo_type()

    assert result.status == OperationStatus.SUCCESS
    assert ops.repo_type == RepoType.PYTEST
    assert "pytest" in result.message


def test_detect_repo_type_go(ops):
    """Test detection of Go."""
    with patch("scripts.coverage_operations.Path") as mock_path_class:

        def path_side_effect(path_str):
            p = MagicMock()
            p.exists.return_value = path_str == "go.mod"
            return p

        mock_path_class.side_effect = path_side_effect
        result = ops.detect_repo_type()

    assert result.status == OperationStatus.SUCCESS
    assert ops.repo_type == RepoType.GO
    assert "Go" in result.message


def test_detect_repo_type_rust(ops):
    """Test detection of Rust."""
    with patch("scripts.coverage_operations.Path") as mock_path_class:

        def path_side_effect(path_str):
            p = MagicMock()
            p.exists.return_value = path_str == "Cargo.toml"
            return p

        mock_path_class.side_effect = path_side_effect
        result = ops.detect_repo_type()

    assert result.status == OperationStatus.SUCCESS
    assert ops.repo_type == RepoType.RUST
    assert "Rust" in result.message


def test_detect_repo_type_unknown(ops):
    """Test unknown repo type."""
    with patch("pathlib.Path.exists", return_value=False):
        result = ops.detect_repo_type()

    assert result.status == OperationStatus.SKIPPED
    assert ops.repo_type == RepoType.UNKNOWN
    assert "No supported test framework" in result.message


def test_detect_repo_type_dry_run(ops_dry_run):
    """Test dry run mode."""
    result = ops_dry_run.detect_repo_type()

    assert result.status == OperationStatus.SUCCESS
    assert "[DRY RUN]" in result.message


# Test: Get Coverage Command


def test_get_coverage_command_jest(ops):
    """Test coverage command for Jest."""
    ops.repo_type = RepoType.JEST
    cmd = ops.get_coverage_command()

    assert cmd[0] == "npm"
    assert "test" in cmd
    assert "--coverage" in cmd
    assert any("json-summary" in arg for arg in cmd)


def test_get_coverage_command_vitest(ops):
    """Test coverage command for Vitest."""
    ops.repo_type = RepoType.VITEST
    cmd = ops.get_coverage_command()

    assert cmd[0] == "npx"
    assert "vitest" in cmd
    assert "--coverage" in cmd


def test_get_coverage_command_pytest_with_uv(ops):
    """Test coverage command for pytest with uv available."""
    ops.repo_type = RepoType.PYTEST

    mock_result = MagicMock()
    mock_result.returncode = 0

    with patch("subprocess.run", return_value=mock_result):
        cmd = ops.get_coverage_command()

    assert "uv" in cmd
    assert "pytest" in cmd
    assert "--cov=." in cmd


def test_get_coverage_command_pytest_without_uv(ops):
    """Test coverage command for pytest without uv."""
    ops.repo_type = RepoType.PYTEST

    mock_result = MagicMock()
    mock_result.returncode = 1

    with patch("subprocess.run", return_value=mock_result):
        cmd = ops.get_coverage_command()

    assert cmd[0] == "pytest"
    assert "--cov=." in cmd


def test_get_coverage_command_go(ops):
    """Test coverage command for Go."""
    ops.repo_type = RepoType.GO
    cmd = ops.get_coverage_command()

    assert cmd[0] == "go"
    assert "test" in cmd
    assert "-coverprofile=coverage.out" in cmd


def test_get_coverage_command_unknown(ops):
    """Test coverage command for unknown type."""
    ops.repo_type = RepoType.UNKNOWN
    cmd = ops.get_coverage_command()

    assert cmd == []


# Test: Parse Diff Lines


def test_parse_diff_lines_single_hunk(ops):
    """Test parsing single diff hunk."""
    patch = """@@ -10,5 +10,7 @@ some context
+added line 1
+added line 2
 unchanged
"""
    lines = ops.parse_diff_lines(patch)

    assert 10 in lines
    assert 11 in lines
    assert len(lines) == 7  # 10-16


def test_parse_diff_lines_multiple_hunks(ops):
    """Test parsing multiple diff hunks."""
    patch = """@@ -10,3 +10,3 @@ context
 unchanged
@@ -20,2 +20,4 @@ more context
+added line 1
+added line 2
"""
    lines = ops.parse_diff_lines(patch)

    assert 10 in lines
    assert 20 in lines
    assert 21 in lines
    assert 22 in lines
    assert 23 in lines


def test_parse_diff_lines_no_count(ops):
    """Test parsing diff hunk with no count (single line)."""
    patch = """@@ -10 +10 @@ context
+single line
"""
    lines = ops.parse_diff_lines(patch)

    assert 10 in lines
    assert len(lines) == 1


def test_parse_diff_lines_empty(ops):
    """Test parsing empty diff."""
    lines = ops.parse_diff_lines("")

    assert lines == []


# Test: Format Line Ranges


def test_format_line_ranges_consecutive(ops):
    """Test formatting consecutive line numbers."""
    result = ops._format_line_ranges([1, 2, 3, 4, 5])

    assert result == "1-5"


def test_format_line_ranges_mixed(ops):
    """Test formatting mixed consecutive and individual lines."""
    result = ops._format_line_ranges([1, 2, 3, 7, 9, 10, 11])

    assert result == "1-3, 7, 9-11"


def test_format_line_ranges_individual(ops):
    """Test formatting individual lines."""
    result = ops._format_line_ranges([1, 3, 5, 7])

    assert result == "1, 3, 5, 7"


def test_format_line_ranges_unsorted(ops):
    """Test formatting unsorted line numbers."""
    result = ops._format_line_ranges([5, 1, 3, 2, 4])

    assert result == "1-5"


def test_format_line_ranges_duplicates(ops):
    """Test formatting with duplicates."""
    result = ops._format_line_ranges([1, 2, 2, 3, 3, 4])

    assert result == "1-4"


def test_format_line_ranges_empty(ops):
    """Test formatting empty list."""
    result = ops._format_line_ranges([])

    assert result == ""


# Test: Calculate Diff Coverage


def test_calculate_diff_coverage_full(ops):
    """Test diff coverage with full coverage."""
    ops.coverage_data = CoverageData(
        total_lines=100,
        covered_lines=85,
        percent_covered=85.0,
        files={
            "foo.py": FileCoverage(
                total_lines=50,
                covered_lines=45,
                percent_covered=90.0,
                uncovered_lines=[5, 10, 15, 20, 25],
            )
        },
    )

    diff_data = {
        "foo.py": [1, 2, 3, 30, 35],  # None are in uncovered_lines
    }

    result = ops.calculate_diff_coverage(diff_data)

    assert result.status == OperationStatus.SUCCESS
    assert ops.diff_coverage_data.percent_covered == 100.0
    assert ops.diff_coverage_data.total_changed_lines == 5
    assert ops.diff_coverage_data.covered_changed_lines == 5


def test_calculate_diff_coverage_partial(ops):
    """Test diff coverage with partial coverage."""
    ops.coverage_data = CoverageData(
        total_lines=100,
        covered_lines=80,
        percent_covered=80.0,
        files={
            "bar.py": FileCoverage(
                total_lines=50,
                covered_lines=40,
                percent_covered=80.0,
                uncovered_lines=[5, 10, 15, 20, 25, 30, 35, 40, 45, 50],
            )
        },
    )

    diff_data = {
        "bar.py": [5, 10, 15, 20, 25],  # All in uncovered_lines
    }

    result = ops.calculate_diff_coverage(diff_data)

    assert result.status == OperationStatus.SUCCESS
    assert ops.diff_coverage_data.percent_covered == 0.0
    assert ops.diff_coverage_data.total_changed_lines == 5
    assert ops.diff_coverage_data.covered_changed_lines == 0


def test_calculate_diff_coverage_mixed(ops):
    """Test diff coverage with mixed coverage."""
    ops.coverage_data = CoverageData(
        total_lines=100,
        covered_lines=80,
        percent_covered=80.0,
        files={
            "baz.py": FileCoverage(
                total_lines=50,
                covered_lines=40,
                percent_covered=80.0,
                uncovered_lines=[5, 10],
            )
        },
    )

    diff_data = {
        "baz.py": [1, 5, 10, 20],  # 5, 10 uncovered; 1, 20 covered
    }

    result = ops.calculate_diff_coverage(diff_data)

    assert result.status == OperationStatus.SUCCESS
    assert ops.diff_coverage_data.percent_covered == 50.0
    assert ops.diff_coverage_data.total_changed_lines == 4
    assert ops.diff_coverage_data.covered_changed_lines == 2


def test_calculate_diff_coverage_new_file(ops):
    """Test diff coverage for new file (not in coverage data)."""
    ops.coverage_data = CoverageData(
        total_lines=100,
        covered_lines=100,
        percent_covered=100.0,
        files={},
    )

    diff_data = {
        "new.py": [1, 2, 3, 4, 5],
    }

    result = ops.calculate_diff_coverage(diff_data)

    assert result.status == OperationStatus.SUCCESS
    # New file treated as all uncovered
    assert ops.diff_coverage_data.percent_covered == 0.0
    assert ops.diff_coverage_data.total_changed_lines == 5
    assert ops.diff_coverage_data.covered_changed_lines == 0


def test_calculate_diff_coverage_no_coverage_data(ops):
    """Test diff coverage with no coverage data."""
    ops.coverage_data = None

    diff_data = {"foo.py": [1, 2, 3]}

    result = ops.calculate_diff_coverage(diff_data)

    assert result.status == OperationStatus.FAILED
    assert "No coverage data" in result.message


# Test: Check Threshold


def test_check_threshold_met(ops):
    """Test threshold check when met."""
    ops.coverage_data = CoverageData(
        total_lines=100,
        covered_lines=85,
        percent_covered=85.0,
        files={},
    )

    result = ops.check_threshold()

    assert result.status == OperationStatus.SUCCESS
    assert "meets threshold" in result.message


def test_check_threshold_not_met_soft(ops):
    """Test threshold check when not met (soft failure)."""
    ops.coverage_data = CoverageData(
        total_lines=100,
        covered_lines=60,
        percent_covered=60.0,
        files={},
    )
    ops.enforce = False

    result = ops.check_threshold()

    assert result.status == OperationStatus.SUCCESS  # Soft fail
    assert "below threshold" in result.message


def test_check_threshold_not_met_hard(ops):
    """Test threshold check when not met (hard failure)."""
    ops.coverage_data = CoverageData(
        total_lines=100,
        covered_lines=60,
        percent_covered=60.0,
        files={},
    )
    ops.enforce = True

    result = ops.check_threshold()

    assert result.status == OperationStatus.FAILED  # Hard fail
    assert "below threshold" in result.message


def test_check_threshold_diff_coverage_priority(ops):
    """Test that diff coverage is used if available."""
    ops.coverage_data = CoverageData(
        total_lines=100,
        covered_lines=60,
        percent_covered=60.0,
        files={},
    )
    ops.diff_coverage_data = DiffCoverageData(
        total_changed_lines=10,
        covered_changed_lines=9,
        percent_covered=90.0,
        files={},
    )

    result = ops.check_threshold()

    assert result.status == OperationStatus.SUCCESS
    assert "90.0%" in result.message


# Test: Generate Report


def test_generate_report_full_coverage_only(ops):
    """Test report generation with full coverage only."""
    ops.coverage_data = CoverageData(
        total_lines=100,
        covered_lines=85,
        percent_covered=85.0,
        files={},
    )
    ops.threshold = 70.0

    report = ops.generate_report()

    assert "## Test Coverage Report" in report
    assert "85.0%" in report
    assert "Threshold**: 70" in report
    assert "✅" in report


def test_generate_report_with_diff_coverage(ops):
    """Test report generation with diff coverage."""
    ops.coverage_data = CoverageData(
        total_lines=100,
        covered_lines=80,
        percent_covered=80.0,
        files={
            "foo.py": FileCoverage(50, 45, 90.0, [5, 10, 15, 20, 25]),
        },
    )
    ops.diff_coverage_data = DiffCoverageData(
        total_changed_lines=10,
        covered_changed_lines=8,
        percent_covered=80.0,
        files={
            "foo.py": FileDiffCoverage(10, 8, 80.0, [5, 25]),
        },
    )
    ops.threshold = 70.0

    report = ops.generate_report()

    assert "Changed Lines Coverage" in report
    assert "80.0%" in report
    assert "foo.py" in report
    assert "Uncovered Changed Lines" in report
    assert "5, 25" in report


def test_generate_report_below_threshold(ops):
    """Test report generation when below threshold."""
    ops.coverage_data = CoverageData(
        total_lines=100,
        covered_lines=65,
        percent_covered=65.0,
        files={},
    )
    ops.threshold = 70.0

    report = ops.generate_report()

    assert "65.0%" in report
    assert "⚠️" in report


# Test: Parse Coverage Report (Jest/Vitest)


def test_parse_jest_vitest_report_success(ops):
    """Test parsing Jest/Vitest coverage report."""
    ops.repo_type = RepoType.JEST

    coverage_data = {
        "total": {"lines": {"total": 100, "covered": 85, "pct": 85.0}},
        "src/foo.ts": {"lines": {"total": 50, "covered": 45, "pct": 90.0}},
    }

    with (
        patch("pathlib.Path.exists", return_value=True),
        patch("builtins.open", mock_open(read_data=json.dumps(coverage_data))),
    ):
        result = ops.parse_coverage_report()

    assert result.status == OperationStatus.SUCCESS
    assert ops.coverage_data.percent_covered == 85.0
    assert ops.coverage_data.total_lines == 100
    assert ops.coverage_data.covered_lines == 85
    assert "src/foo.ts" in ops.coverage_data.files


def test_parse_jest_vitest_report_missing(ops):
    """Test parsing when report file missing."""
    ops.repo_type = RepoType.JEST

    with patch("pathlib.Path.exists", return_value=False):
        result = ops.parse_coverage_report()

    assert result.status == OperationStatus.FAILED
    assert "not found" in result.message


# Test: Parse Coverage Report (pytest)


def test_parse_pytest_report_success(ops):
    """Test parsing pytest coverage report."""
    ops.repo_type = RepoType.PYTEST

    coverage_data = {
        "totals": {
            "num_statements": 100,
            "covered_lines": 85,
            "percent_covered": 85.0,
        },
        "files": {
            "src/foo.py": {
                "summary": {
                    "num_statements": 50,
                    "covered_lines": 45,
                    "percent_covered": 90.0,
                },
                "missing_lines": [5, 10, 15, 20, 25],
            }
        },
    }

    with (
        patch("pathlib.Path.exists", return_value=True),
        patch("builtins.open", mock_open(read_data=json.dumps(coverage_data))),
    ):
        result = ops.parse_coverage_report()

    assert result.status == OperationStatus.SUCCESS
    assert ops.coverage_data.percent_covered == 85.0
    assert ops.coverage_data.total_lines == 100
    assert ops.coverage_data.covered_lines == 85
    assert "src/foo.py" in ops.coverage_data.files
    assert ops.coverage_data.files["src/foo.py"].uncovered_lines == [5, 10, 15, 20, 25]


# Test: Parse Coverage Report (Go)


def test_parse_go_report_success(ops):
    """Test parsing Go coverage report."""
    ops.repo_type = RepoType.GO

    coverage_out = """mode: set
path/to/file.go:10.2,12.3 2 1
path/to/file.go:15.1,18.5 3 0
path/to/other.go:5.1,7.2 2 1
"""

    with (
        patch("pathlib.Path.exists", return_value=True),
        patch("builtins.open", mock_open(read_data=coverage_out)),
    ):
        result = ops.parse_coverage_report()

    assert result.status == OperationStatus.SUCCESS
    # 2 covered + 3 uncovered + 2 covered = 7 total, 4 covered = 57.14%
    assert ops.coverage_data.total_lines == 7
    assert ops.coverage_data.covered_lines == 4
    assert abs(ops.coverage_data.percent_covered - 57.14) < 0.1
