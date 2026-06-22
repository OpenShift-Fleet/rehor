"""
Test coverage evaluation operations.

Evaluates test coverage for the current branch/PR:
1. detect_repo_type - determine language/framework from repo files
2. run_coverage - execute appropriate coverage command
3. parse_coverage_report - extract coverage metrics
4. get_pr_diff - fetch changed files/lines (if --diff-only)
5. calculate_diff_coverage - intersect coverage with changed lines
6. check_threshold - enforce coverage thresholds
7. generate_report - format human-readable summary
8. post_pr_comment - add report to PR (if --pr-comment)
9. store_metrics - save to memory for trend analysis

All operations follow fail-fast pattern from existing skills.
"""

import argparse
import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Dict, List, Optional

# Memory server integration
try:
    import httpx

    HAS_HTTPX = True
except ImportError:
    HAS_HTTPX = False


class OperationStatus(Enum):
    """Status of an individual operation."""

    SUCCESS = "success"
    FAILED = "failed"
    SKIPPED = "skipped"


class RepoType(Enum):
    """Repository type based on test framework."""

    JEST = "jest"
    VITEST = "vitest"
    PYTEST = "pytest"
    GO = "go"
    RUST = "rust"
    UNKNOWN = "unknown"


@dataclass
class OperationResult:
    """Result of a single operation."""

    operation: str
    status: OperationStatus
    message: str
    details: Optional[Dict[str, Any]] = None


@dataclass
class FileCoverage:
    """Coverage data for a single file."""

    total_lines: int
    covered_lines: int
    percent_covered: float
    uncovered_lines: List[int] = field(default_factory=list)


@dataclass
class CoverageData:
    """Overall coverage data."""

    total_lines: int
    covered_lines: int
    percent_covered: float
    files: Dict[str, FileCoverage] = field(default_factory=dict)


@dataclass
class FileDiffCoverage:
    """Diff coverage for a single file."""

    total_changed: int
    covered_changed: int
    percent_covered: float
    uncovered_changed_lines: List[int] = field(default_factory=list)


@dataclass
class DiffCoverageData:
    """Diff-only coverage data."""

    total_changed_lines: int
    covered_changed_lines: int
    percent_covered: float
    files: Dict[str, FileDiffCoverage] = field(default_factory=dict)


@dataclass
class WorkflowResult:
    """Result of the entire workflow."""

    success: bool
    operations: List[OperationResult]
    coverage_data: Optional[CoverageData] = None
    diff_coverage_data: Optional[DiffCoverageData] = None
    threshold_met: bool = False


class CoverageOperations:
    """Handles all test coverage operations."""

    def __init__(
        self,
        threshold: float = 70.0,
        diff_only: bool = False,
        pr_comment: bool = False,
        enforce: bool = False,
        dry_run: bool = False,
    ):
        """
        Initialize coverage operations handler.

        Args:
            threshold: Required coverage percentage (default: 70)
            diff_only: Only check coverage for changed lines
            pr_comment: Post coverage report as PR comment
            enforce: Exit 1 if threshold not met
            dry_run: Preview without executing
        """
        self.threshold = threshold
        self.diff_only = diff_only
        self.pr_comment = pr_comment
        self.enforce = enforce
        self.dry_run = dry_run

        # Workflow state
        self.repo_type: Optional[RepoType] = None
        self.coverage_data: Optional[CoverageData] = None
        self.diff_coverage_data: Optional[DiffCoverageData] = None
        self.pr_number: Optional[str] = None
        self.owner_repo: Optional[str] = None

    def detect_repo_type(self) -> OperationResult:
        """Detect repository type based on configuration files."""
        if self.dry_run:
            return OperationResult(
                operation="detect_repo_type",
                status=OperationStatus.SUCCESS,
                message="[DRY RUN] Would detect repository type",
            )

        # Check for JavaScript/TypeScript (package.json)
        if Path("package.json").exists():
            try:
                with open("package.json") as f:
                    pkg = json.load(f)
                    dev_deps = pkg.get("devDependencies", {})
                    deps = pkg.get("dependencies", {})

                    if "jest" in dev_deps or "jest" in deps:
                        self.repo_type = RepoType.JEST
                        return OperationResult(
                            operation="detect_repo_type",
                            status=OperationStatus.SUCCESS,
                            message="Detected Jest (JavaScript/TypeScript)",
                            details={"repo_type": "jest"},
                        )
                    elif "vitest" in dev_deps or "vitest" in deps:
                        self.repo_type = RepoType.VITEST
                        return OperationResult(
                            operation="detect_repo_type",
                            status=OperationStatus.SUCCESS,
                            message="Detected Vitest (JavaScript/TypeScript)",
                            details={"repo_type": "vitest"},
                        )
            except Exception as e:
                return OperationResult(
                    operation="detect_repo_type",
                    status=OperationStatus.FAILED,
                    message=f"Failed to parse package.json: {e}",
                )

        # Check for Python (pyproject.toml or setup.py)
        if Path("pyproject.toml").exists() or Path("setup.py").exists():
            self.repo_type = RepoType.PYTEST
            return OperationResult(
                operation="detect_repo_type",
                status=OperationStatus.SUCCESS,
                message="Detected pytest (Python)",
                details={"repo_type": "pytest"},
            )

        # Check for Go (go.mod)
        if Path("go.mod").exists():
            self.repo_type = RepoType.GO
            return OperationResult(
                operation="detect_repo_type",
                status=OperationStatus.SUCCESS,
                message="Detected Go",
                details={"repo_type": "go"},
            )

        # Check for Rust (Cargo.toml)
        if Path("Cargo.toml").exists():
            self.repo_type = RepoType.RUST
            return OperationResult(
                operation="detect_repo_type",
                status=OperationStatus.SUCCESS,
                message="Detected Rust",
                details={"repo_type": "rust"},
            )

        # Unknown type
        self.repo_type = RepoType.UNKNOWN
        return OperationResult(
            operation="detect_repo_type",
            status=OperationStatus.SKIPPED,
            message="No supported test framework detected (jest/vitest/pytest/go/rust)",
            details={"repo_type": "unknown"},
        )

    def get_coverage_command(self) -> List[str]:
        """Get coverage command for detected repo type."""
        if self.repo_type == RepoType.JEST:
            return [
                "npm",
                "test",
                "--",
                "--coverage",
                "--coverageReporters=json-summary",
                "--coverageReporters=text",
            ]
        elif self.repo_type == RepoType.VITEST:
            return [
                "npx",
                "vitest",
                "run",
                "--coverage",
                "--coverage.reporter=json-summary",
                "--coverage.reporter=text",
            ]
        elif self.repo_type == RepoType.PYTEST:
            # Check if uv is available (preferred for bot skills)
            uv_available = (
                subprocess.run(
                    ["which", "uv"],
                    capture_output=True,
                    timeout=5,
                ).returncode
                == 0
            )

            if uv_available:
                return [
                    "uv",
                    "run",
                    "pytest",
                    "--cov=.",
                    "--cov-report=json",
                    "--cov-report=term",
                ]
            else:
                return [
                    "pytest",
                    "--cov=.",
                    "--cov-report=json",
                    "--cov-report=term",
                ]
        elif self.repo_type == RepoType.GO:
            # Go coverage requires two commands (profile + report)
            return ["go", "test", "./...", "-coverprofile=coverage.out"]
        elif self.repo_type == RepoType.RUST:
            return ["cargo", "test", "--all-features"]
        else:
            return []

    def run_coverage(self) -> OperationResult:
        """Execute coverage command for repo type."""
        if self.dry_run:
            cmd = self.get_coverage_command()
            return OperationResult(
                operation="run_coverage",
                status=OperationStatus.SUCCESS,
                message=f"[DRY RUN] Would run: {' '.join(cmd)}",
            )

        if self.repo_type == RepoType.UNKNOWN:
            return OperationResult(
                operation="run_coverage",
                status=OperationStatus.SKIPPED,
                message="Cannot run coverage for unknown repo type",
            )

        cmd = self.get_coverage_command()
        if not cmd:
            return OperationResult(
                operation="run_coverage",
                status=OperationStatus.FAILED,
                message=f"No coverage command defined for {self.repo_type.value}",
            )

        try:
            print(f"Running coverage: {' '.join(cmd)}", file=sys.stderr)
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=300,  # 5 minute timeout
            )

            # Go requires second command to generate report
            if self.repo_type == RepoType.GO and result.returncode == 0:
                func_cmd = ["go", "tool", "cover", "-func=coverage.out"]
                subprocess.run(func_cmd, capture_output=True, text=True, timeout=30)

            if result.returncode != 0:
                return OperationResult(
                    operation="run_coverage",
                    status=OperationStatus.FAILED,
                    message=f"Coverage command failed: {result.stderr[:500]}",
                    details={"returncode": result.returncode, "stderr": result.stderr},
                )

            return OperationResult(
                operation="run_coverage",
                status=OperationStatus.SUCCESS,
                message=f"Coverage command completed: {self.repo_type.value}",
                details={"stdout": result.stdout[:1000]},
            )

        except subprocess.TimeoutExpired:
            return OperationResult(
                operation="run_coverage",
                status=OperationStatus.FAILED,
                message="Coverage command timed out after 5 minutes",
            )
        except Exception as e:
            return OperationResult(
                operation="run_coverage",
                status=OperationStatus.FAILED,
                message=f"Failed to run coverage: {e}",
            )

    def parse_coverage_report(self) -> OperationResult:
        """Parse coverage report based on repo type."""
        if self.dry_run:
            return OperationResult(
                operation="parse_coverage_report",
                status=OperationStatus.SUCCESS,
                message="[DRY RUN] Would parse coverage report",
            )

        try:
            if self.repo_type == RepoType.JEST or self.repo_type == RepoType.VITEST:
                return self._parse_jest_vitest_report()
            elif self.repo_type == RepoType.PYTEST:
                return self._parse_pytest_report()
            elif self.repo_type == RepoType.GO:
                return self._parse_go_report()
            else:
                return OperationResult(
                    operation="parse_coverage_report",
                    status=OperationStatus.SKIPPED,
                    message=f"No parser for {self.repo_type.value}",
                )

        except Exception as e:
            return OperationResult(
                operation="parse_coverage_report",
                status=OperationStatus.FAILED,
                message=f"Failed to parse coverage report: {e}",
            )

    def _parse_jest_vitest_report(self) -> OperationResult:
        """Parse Jest/Vitest coverage-summary.json."""
        report_path = Path("coverage/coverage-summary.json")
        if not report_path.exists():
            return OperationResult(
                operation="parse_coverage_report",
                status=OperationStatus.FAILED,
                message="Coverage report not found: coverage/coverage-summary.json",
            )

        with open(report_path) as f:
            data = json.load(f)

        total = data.get("total", {})
        lines = total.get("lines", {})

        self.coverage_data = CoverageData(
            total_lines=lines.get("total", 0),
            covered_lines=lines.get("covered", 0),
            percent_covered=lines.get("pct", 0.0),
            files={},
        )

        # Parse per-file coverage
        for file_path, file_data in data.items():
            if file_path == "total":
                continue

            file_lines = file_data.get("lines", {})
            # Jest/Vitest don't provide uncovered line numbers in summary
            # Would need full coverage.json for that
            self.coverage_data.files[file_path] = FileCoverage(
                total_lines=file_lines.get("total", 0),
                covered_lines=file_lines.get("covered", 0),
                percent_covered=file_lines.get("pct", 0.0),
                uncovered_lines=[],  # Not available in summary
            )

        return OperationResult(
            operation="parse_coverage_report",
            status=OperationStatus.SUCCESS,
            message=f"Parsed coverage: {self.coverage_data.percent_covered:.1f}% ({self.coverage_data.covered_lines}/{self.coverage_data.total_lines} lines)",
            details={
                "total_pct": self.coverage_data.percent_covered,
                "files_count": len(self.coverage_data.files),
            },
        )

    def _parse_pytest_report(self) -> OperationResult:
        """Parse pytest coverage.json."""
        report_path = Path("coverage.json")
        if not report_path.exists():
            return OperationResult(
                operation="parse_coverage_report",
                status=OperationStatus.FAILED,
                message="Coverage report not found: coverage.json",
            )

        with open(report_path) as f:
            data = json.load(f)

        totals = data.get("totals", {})

        self.coverage_data = CoverageData(
            total_lines=totals.get("num_statements", 0),
            covered_lines=totals.get("covered_lines", 0),
            percent_covered=totals.get("percent_covered", 0.0),
            files={},
        )

        # Parse per-file coverage
        for file_path, file_data in data.get("files", {}).items():
            summary = file_data.get("summary", {})
            missing_lines = file_data.get("missing_lines", [])

            self.coverage_data.files[file_path] = FileCoverage(
                total_lines=summary.get("num_statements", 0),
                covered_lines=summary.get("covered_lines", 0),
                percent_covered=summary.get("percent_covered", 0.0),
                uncovered_lines=missing_lines,
            )

        return OperationResult(
            operation="parse_coverage_report",
            status=OperationStatus.SUCCESS,
            message=f"Parsed coverage: {self.coverage_data.percent_covered:.1f}% ({self.coverage_data.covered_lines}/{self.coverage_data.total_lines} lines)",
            details={
                "total_pct": self.coverage_data.percent_covered,
                "files_count": len(self.coverage_data.files),
            },
        )

    def _parse_go_report(self) -> OperationResult:
        """Parse Go coverage.out."""
        report_path = Path("coverage.out")
        if not report_path.exists():
            return OperationResult(
                operation="parse_coverage_report",
                status=OperationStatus.FAILED,
                message="Coverage report not found: coverage.out",
            )

        # Parse coverage.out format:
        # mode: set
        # path/to/file.go:10.2,12.3 1 1
        # Format: file:start.col,end.col num_statements count

        total_statements = 0
        covered_statements = 0

        with open(report_path) as f:
            for line in f:
                if line.startswith("mode:"):
                    continue

                parts = line.strip().split()
                if len(parts) >= 3:
                    num_stmts = int(parts[1])
                    count = int(parts[2])

                    total_statements += num_stmts
                    if count > 0:
                        covered_statements += num_stmts

        pct = (
            (covered_statements / total_statements * 100)
            if total_statements > 0
            else 0.0
        )

        self.coverage_data = CoverageData(
            total_lines=total_statements,
            covered_lines=covered_statements,
            percent_covered=pct,
            files={},  # Go report doesn't easily break down by file
        )

        return OperationResult(
            operation="parse_coverage_report",
            status=OperationStatus.SUCCESS,
            message=f"Parsed coverage: {self.coverage_data.percent_covered:.1f}% ({self.coverage_data.covered_lines}/{self.coverage_data.total_lines} statements)",
            details={"total_pct": self.coverage_data.percent_covered},
        )

    def parse_diff_lines(self, patch: str) -> List[int]:
        """Extract added/modified line numbers from unified diff patch."""
        lines = []
        for line in patch.split("\n"):
            if line.startswith("@@"):
                # Parse @@ -old_start,old_count +new_start,new_count @@
                match = re.search(r"\+(\d+),?(\d*)", line)
                if match:
                    start = int(match.group(1))
                    count = int(match.group(2) or "1")
                    lines.extend(range(start, start + count))
        return lines

    def get_pr_diff(self) -> OperationResult:
        """Fetch PR diff to get changed files and line numbers."""
        if self.dry_run:
            return OperationResult(
                operation="get_pr_diff",
                status=OperationStatus.SUCCESS,
                message="[DRY RUN] Would fetch PR diff",
            )

        # Detect PR number from git branch (bot/<TICKET-KEY>)
        try:
            # Try to find PR via gh/glab
            # First try GitHub
            gh_result = subprocess.run(
                ["gh", "pr", "view", "--json", "number,files"],
                capture_output=True,
                text=True,
                timeout=30,
            )

            if gh_result.returncode == 0:
                pr_data = json.loads(gh_result.stdout)
                self.pr_number = str(pr_data["number"])
                files = pr_data.get("files", [])

                diff_data = {}
                for file_info in files:
                    path = file_info.get("path", "")
                    patch = file_info.get("patch", "")
                    if patch:
                        diff_data[path] = self.parse_diff_lines(patch)

                return OperationResult(
                    operation="get_pr_diff",
                    status=OperationStatus.SUCCESS,
                    message=f"Fetched PR #{self.pr_number} diff ({len(diff_data)} files changed)",
                    details={"pr_number": self.pr_number, "diff": diff_data},
                )

            # Try GitLab
            # (Would need glab API call - simplified for now)

            return OperationResult(
                operation="get_pr_diff",
                status=OperationStatus.SKIPPED,
                message="No PR found for current branch (not yet created or not in a PR branch)",
            )

        except Exception as e:
            return OperationResult(
                operation="get_pr_diff",
                status=OperationStatus.FAILED,
                message=f"Failed to fetch PR diff: {e}",
            )

    def calculate_diff_coverage(
        self, diff_data: Dict[str, List[int]]
    ) -> OperationResult:
        """Calculate coverage for changed lines only."""
        if self.dry_run:
            return OperationResult(
                operation="calculate_diff_coverage",
                status=OperationStatus.SUCCESS,
                message="[DRY RUN] Would calculate diff coverage",
            )

        if not self.coverage_data:
            return OperationResult(
                operation="calculate_diff_coverage",
                status=OperationStatus.FAILED,
                message="No coverage data available",
            )

        total_changed = 0
        covered_changed = 0
        files_diff = {}

        for file_path, changed_lines in diff_data.items():
            file_cov = self.coverage_data.files.get(file_path)

            if not file_cov:
                # File has no coverage data (new file or not in report)
                uncovered_changed = changed_lines
            else:
                # Find which changed lines are uncovered
                uncovered_changed = [
                    line for line in changed_lines if line in file_cov.uncovered_lines
                ]

            total_file_changed = len(changed_lines)
            covered_file_changed = total_file_changed - len(uncovered_changed)
            pct = (
                (covered_file_changed / total_file_changed * 100)
                if total_file_changed > 0
                else 100.0
            )

            files_diff[file_path] = FileDiffCoverage(
                total_changed=total_file_changed,
                covered_changed=covered_file_changed,
                percent_covered=pct,
                uncovered_changed_lines=uncovered_changed,
            )

            total_changed += total_file_changed
            covered_changed += covered_file_changed

        overall_pct = (
            (covered_changed / total_changed * 100) if total_changed > 0 else 100.0
        )

        self.diff_coverage_data = DiffCoverageData(
            total_changed_lines=total_changed,
            covered_changed_lines=covered_changed,
            percent_covered=overall_pct,
            files=files_diff,
        )

        return OperationResult(
            operation="calculate_diff_coverage",
            status=OperationStatus.SUCCESS,
            message=f"Diff coverage: {overall_pct:.1f}% ({covered_changed}/{total_changed} changed lines covered)",
            details={
                "diff_pct": overall_pct,
                "files_count": len(files_diff),
            },
        )

    def check_threshold(self) -> OperationResult:
        """Check if coverage meets threshold."""
        if self.dry_run:
            return OperationResult(
                operation="check_threshold",
                status=OperationStatus.SUCCESS,
                message=f"[DRY RUN] Would check threshold: {self.threshold}%",
            )

        # Use diff coverage if available, otherwise full coverage
        coverage_pct = (
            self.diff_coverage_data.percent_covered
            if self.diff_coverage_data
            else self.coverage_data.percent_covered
            if self.coverage_data
            else 0.0
        )

        met = coverage_pct >= self.threshold

        if met:
            return OperationResult(
                operation="check_threshold",
                status=OperationStatus.SUCCESS,
                message=f"Coverage {coverage_pct:.1f}% meets threshold {self.threshold}%",
                details={"threshold_met": True, "coverage_pct": coverage_pct},
            )
        else:
            return OperationResult(
                operation="check_threshold",
                status=OperationStatus.FAILED
                if self.enforce
                else OperationStatus.SUCCESS,
                message=f"Coverage {coverage_pct:.1f}% below threshold {self.threshold}%",
                details={"threshold_met": False, "coverage_pct": coverage_pct},
            )

    def generate_report(self) -> str:
        """Generate markdown coverage report."""
        lines = ["## Test Coverage Report\n"]

        # Overall coverage
        if self.coverage_data:
            cov = self.coverage_data
            met_icon = "✅" if cov.percent_covered >= self.threshold else "⚠️"
            lines.append("### Overall Coverage")
            lines.append(
                f"- **Total**: {cov.percent_covered:.1f}% ({cov.covered_lines}/{cov.total_lines} lines)"
            )
            lines.append(f"- **Threshold**: {self.threshold}% {met_icon}\n")

        # Diff coverage
        if self.diff_coverage_data:
            diff_cov = self.diff_coverage_data
            met_icon = "✅" if diff_cov.percent_covered >= self.threshold else "⚠️"
            lines.append("### Changed Lines Coverage (Diff)")
            lines.append(f"- **Total Changed**: {diff_cov.total_changed_lines} lines")
            lines.append(
                f"- **Covered**: {diff_cov.covered_changed_lines} lines ({diff_cov.percent_covered:.1f}%) {met_icon}\n"
            )

            # Per-file diff coverage
            if diff_cov.files:
                lines.append("### Files")
                lines.append("| File | Coverage | Changed Lines | Diff Coverage |")
                lines.append("|------|----------|---------------|---------------|")

                for file_path, file_diff in diff_cov.files.items():
                    file_cov = (
                        self.coverage_data.files.get(file_path)
                        if self.coverage_data
                        else None
                    )
                    overall = (
                        f"{file_cov.percent_covered:.0f}% ({file_cov.covered_lines}/{file_cov.total_lines})"
                        if file_cov
                        else "N/A"
                    )
                    diff_icon = (
                        "✅" if file_diff.percent_covered >= self.threshold else "⚠️"
                    )

                    lines.append(
                        f"| `{file_path}` | {overall} | {file_diff.total_changed} | "
                        f"{file_diff.percent_covered:.0f}% ({file_diff.covered_changed}/{file_diff.total_changed}) {diff_icon} |"
                    )

                # Uncovered changed lines
                uncovered_files = {
                    path: diff.uncovered_changed_lines
                    for path, diff in diff_cov.files.items()
                    if diff.uncovered_changed_lines
                }

                if uncovered_files:
                    lines.append("\n### Uncovered Changed Lines")
                    for file_path, uncovered_lines in uncovered_files.items():
                        line_ranges = self._format_line_ranges(uncovered_lines)
                        lines.append(f"- `{file_path}`: Lines {line_ranges}")

        lines.append("\n---")
        lines.append("🤖 Generated by [Claude Code](https://claude.com/claude-code)")

        return "\n".join(lines)

    def _format_line_ranges(self, lines: List[int]) -> str:
        """Format list of line numbers as ranges (e.g., '1-3, 5, 7-9')."""
        if not lines:
            return ""

        lines = sorted(set(lines))
        ranges = []
        start = lines[0]
        end = lines[0]

        for line in lines[1:]:
            if line == end + 1:
                end = line
            else:
                if start == end:
                    ranges.append(str(start))
                else:
                    ranges.append(f"{start}-{end}")
                start = end = line

        # Add final range
        if start == end:
            ranges.append(str(start))
        else:
            ranges.append(f"{start}-{end}")

        return ", ".join(ranges)

    def post_pr_comment(self, report: str) -> OperationResult:
        """Post coverage report as PR comment."""
        if self.dry_run:
            return OperationResult(
                operation="post_pr_comment",
                status=OperationStatus.SUCCESS,
                message="[DRY RUN] Would post PR comment",
            )

        if not self.pr_number:
            return OperationResult(
                operation="post_pr_comment",
                status=OperationStatus.SKIPPED,
                message="No PR number available",
            )

        try:
            # Try GitHub first
            result = subprocess.run(
                ["gh", "pr", "comment", self.pr_number, "--body", report],
                capture_output=True,
                text=True,
                timeout=30,
            )

            if result.returncode == 0:
                return OperationResult(
                    operation="post_pr_comment",
                    status=OperationStatus.SUCCESS,
                    message=f"Posted coverage report to PR #{self.pr_number}",
                )
            else:
                return OperationResult(
                    operation="post_pr_comment",
                    status=OperationStatus.FAILED,
                    message=f"Failed to post PR comment: {result.stderr}",
                )

        except Exception as e:
            return OperationResult(
                operation="post_pr_comment",
                status=OperationStatus.FAILED,
                message=f"Failed to post PR comment: {e}",
            )

    def store_metrics(self) -> OperationResult:
        """Store coverage metrics to memory server."""
        if self.dry_run:
            return OperationResult(
                operation="store_metrics",
                status=OperationStatus.SUCCESS,
                message="[DRY RUN] Would store coverage metrics",
            )

        if not HAS_HTTPX:
            return OperationResult(
                operation="store_metrics",
                status=OperationStatus.SKIPPED,
                message="httpx not available (cannot store metrics)",
            )

        memory_url = os.environ.get("BOT_MEMORY_URL", "").rstrip("/")
        if not memory_url:
            return OperationResult(
                operation="store_metrics",
                status=OperationStatus.SKIPPED,
                message="BOT_MEMORY_URL not set (cannot store metrics)",
            )

        try:
            metrics = {
                "total_pct": self.coverage_data.percent_covered
                if self.coverage_data
                else None,
                "diff_pct": self.diff_coverage_data.percent_covered
                if self.diff_coverage_data
                else None,
                "threshold": self.threshold,
                "passed": (
                    self.diff_coverage_data.percent_covered >= self.threshold
                    if self.diff_coverage_data
                    else self.coverage_data.percent_covered >= self.threshold
                    if self.coverage_data
                    else False
                ),
            }

            # Get current repo name
            repo_result = subprocess.run(
                ["git", "remote", "get-url", "origin"],
                capture_output=True,
                text=True,
                timeout=10,
            )
            repo_name = (
                repo_result.stdout.strip().split("/")[-1].replace(".git", "")
                if repo_result.returncode == 0
                else "unknown"
            )

            response = httpx.post(
                f"{memory_url}/memory",
                json={
                    "category": "coverage_metrics",
                    "title": f"Coverage report for {repo_name}",
                    "content": json.dumps(metrics),
                    "repo": repo_name,
                    "tags": ["coverage", "metrics"],
                },
                timeout=30,
            )

            if response.status_code == 200:
                return OperationResult(
                    operation="store_metrics",
                    status=OperationStatus.SUCCESS,
                    message="Stored coverage metrics to memory",
                )
            else:
                return OperationResult(
                    operation="store_metrics",
                    status=OperationStatus.FAILED,
                    message=f"Failed to store metrics: HTTP {response.status_code}",
                )

        except Exception as e:
            return OperationResult(
                operation="store_metrics",
                status=OperationStatus.SKIPPED,
                message=f"Could not store metrics: {e}",
            )

    def execute_workflow(self) -> WorkflowResult:
        """Execute full coverage evaluation workflow."""
        operations = []

        # 1. Detect repository type
        result = self.detect_repo_type()
        operations.append(result)
        if result.status == OperationStatus.FAILED:
            return WorkflowResult(success=False, operations=operations)

        # 2. Run coverage
        result = self.run_coverage()
        operations.append(result)
        if result.status == OperationStatus.FAILED:
            return WorkflowResult(success=False, operations=operations)

        # 3. Parse coverage report
        result = self.parse_coverage_report()
        operations.append(result)
        if result.status == OperationStatus.FAILED:
            return WorkflowResult(success=False, operations=operations)

        # 4. Get PR diff (if diff-only mode)
        diff_data = None
        if self.diff_only:
            result = self.get_pr_diff()
            operations.append(result)
            if result.status == OperationStatus.SUCCESS and result.details:
                diff_data = result.details.get("diff")

        # 5. Calculate diff coverage (if we have diff data)
        if diff_data:
            result = self.calculate_diff_coverage(diff_data)
            operations.append(result)
            if result.status == OperationStatus.FAILED:
                return WorkflowResult(success=False, operations=operations)

        # 6. Check threshold
        result = self.check_threshold()
        operations.append(result)
        threshold_met = (
            result.details.get("threshold_met", False) if result.details else False
        )

        if result.status == OperationStatus.FAILED and self.enforce:
            # Hard fail if --enforce and threshold not met
            return WorkflowResult(
                success=False,
                operations=operations,
                coverage_data=self.coverage_data,
                diff_coverage_data=self.diff_coverage_data,
                threshold_met=False,
            )

        # 7. Generate and optionally post report
        if self.pr_comment:
            report = self.generate_report()
            result = self.post_pr_comment(report)
            operations.append(result)

        # 8. Store metrics
        result = self.store_metrics()
        operations.append(result)

        return WorkflowResult(
            success=True,
            operations=operations,
            coverage_data=self.coverage_data,
            diff_coverage_data=self.diff_coverage_data,
            threshold_met=threshold_met,
        )


def main():
    """Main entry point."""
    parser = argparse.ArgumentParser(
        description="Evaluate test coverage for current branch/PR"
    )
    parser.add_argument(
        "--threshold",
        type=float,
        default=70.0,
        help="Coverage threshold percentage (default: 70)",
    )
    parser.add_argument(
        "--diff-only",
        action="store_true",
        help="Only check coverage for changed lines",
    )
    parser.add_argument(
        "--pr-comment",
        action="store_true",
        help="Post coverage report as PR comment",
    )
    parser.add_argument(
        "--enforce",
        action="store_true",
        help="Exit 1 if threshold not met (for CI)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Preview without executing",
    )

    args = parser.parse_args()

    # Initialize and execute
    ops = CoverageOperations(
        threshold=args.threshold,
        diff_only=args.diff_only,
        pr_comment=args.pr_comment,
        enforce=args.enforce,
        dry_run=args.dry_run,
    )

    result = ops.execute_workflow()

    # Print operation results
    for op in result.operations:
        status_icon = {
            OperationStatus.SUCCESS: "✓",
            OperationStatus.FAILED: "✗",
            OperationStatus.SKIPPED: "○",
        }[op.status]

        print(f"{status_icon} [{op.operation}] {op.message}")

    # Print coverage report
    if result.coverage_data and not args.pr_comment:
        print("\n" + ops.generate_report())

    # Exit code
    sys.exit(0 if result.success and result.threshold_met else 1)


if __name__ == "__main__":
    main()
