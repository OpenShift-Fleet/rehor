"""
Test coverage evaluation operations (refactored).

Evaluates test coverage for the current branch/PR with auto-detection of
test frameworks and threshold enforcement.
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
class DiffCoverageData:
    """Diff-only coverage data."""

    total_changed_lines: int
    covered_changed_lines: int
    percent_covered: float
    files: Dict[str, "FileDiffCoverage"] = field(default_factory=dict)


@dataclass
class FileDiffCoverage:
    """Diff coverage for a single file."""

    total_changed: int
    covered_changed: int
    percent_covered: float
    uncovered_changed_lines: List[int] = field(default_factory=list)


@dataclass
class WorkflowResult:
    """Result of the entire workflow."""

    success: bool
    operations: List[OperationResult]
    coverage_data: Optional[CoverageData] = None
    diff_coverage_data: Optional[DiffCoverageData] = None
    threshold_met: bool = False


# Framework configuration (data-driven)
FRAMEWORK_CONFIG = {
    RepoType.JEST: {
        "detect_file": "package.json",
        "detect_key": "jest",
        "command": [
            "npm",
            "test",
            "--",
            "--coverage",
            "--coverageReporters=json-summary",
            "--coverageReporters=text",
        ],
        "report_path": "coverage/coverage-summary.json",
        "report_format": "jest",
    },
    RepoType.VITEST: {
        "detect_file": "package.json",
        "detect_key": "vitest",
        "command": [
            "npx",
            "vitest",
            "run",
            "--coverage",
            "--coverage.reporter=json-summary",
            "--coverage.reporter=text",
        ],
        "report_path": "coverage/coverage-summary.json",
        "report_format": "jest",
    },
    RepoType.PYTEST: {
        "detect_file": "pyproject.toml",
        "detect_key": None,
        "command": ["pytest", "--cov=.", "--cov-report=json", "--cov-report=term"],
        "report_path": "coverage.json",
        "report_format": "pytest",
    },
    RepoType.GO: {
        "detect_file": "go.mod",
        "detect_key": None,
        "command": ["go", "test", "./...", "-coverprofile=coverage.out"],
        "report_path": "coverage.out",
        "report_format": "go",
    },
}


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
        self.threshold = threshold
        self.diff_only = diff_only
        self.pr_comment = pr_comment
        self.enforce = enforce
        self.dry_run = dry_run

        self.repo_type: Optional[RepoType] = None
        self.coverage_data: Optional[CoverageData] = None
        self.diff_coverage_data: Optional[DiffCoverageData] = None
        self.pr_number: Optional[str] = None

    def _op_result(
        self,
        operation: str,
        status: OperationStatus,
        message: str,
        details: Optional[Dict] = None,
    ) -> OperationResult:
        """Helper to create OperationResult."""
        return OperationResult(operation, status, message, details)

    def _dry_run_result(self, operation: str, action: str) -> OperationResult:
        """Helper for dry-run results."""
        return self._op_result(
            operation, OperationStatus.SUCCESS, f"[DRY RUN] Would {action}"
        )

    def detect_repo_type(self) -> OperationResult:
        """Detect repository type based on configuration files."""
        if self.dry_run:
            return self._dry_run_result("detect_repo_type", "detect repository type")

        # Check package.json for JS frameworks
        if Path("package.json").exists():
            try:
                with open("package.json") as f:
                    pkg = json.load(f)
                    deps = {
                        **pkg.get("devDependencies", {}),
                        **pkg.get("dependencies", {}),
                    }

                    for repo_type in [RepoType.JEST, RepoType.VITEST]:
                        key = FRAMEWORK_CONFIG[repo_type]["detect_key"]
                        if key in deps:
                            self.repo_type = repo_type
                            return self._op_result(
                                "detect_repo_type",
                                OperationStatus.SUCCESS,
                                f"Detected {repo_type.value} (JavaScript/TypeScript)",
                                {"repo_type": repo_type.value},
                            )
            except Exception as e:
                return self._op_result(
                    "detect_repo_type",
                    OperationStatus.FAILED,
                    f"Failed to parse package.json: {e}",
                )

        # Check other frameworks
        for repo_type in [RepoType.PYTEST, RepoType.GO]:
            detect_file = FRAMEWORK_CONFIG[repo_type]["detect_file"]
            if Path(detect_file).exists():
                self.repo_type = repo_type
                lang = "Python" if repo_type == RepoType.PYTEST else repo_type.value
                return self._op_result(
                    "detect_repo_type",
                    OperationStatus.SUCCESS,
                    f"Detected {repo_type.value} ({lang})",
                    {"repo_type": repo_type.value},
                )

        # Unknown
        self.repo_type = RepoType.UNKNOWN
        return self._op_result(
            "detect_repo_type",
            OperationStatus.SKIPPED,
            "No supported test framework detected (jest/vitest/pytest/go)",
            {"repo_type": "unknown"},
        )

    def run_coverage(self) -> OperationResult:
        """Execute coverage command for repo type."""
        if self.dry_run:
            cmd = self._get_coverage_command()
            return self._dry_run_result("run_coverage", f"run: {' '.join(cmd)}")

        if self.repo_type == RepoType.UNKNOWN or self.repo_type not in FRAMEWORK_CONFIG:
            return self._op_result(
                "run_coverage",
                OperationStatus.SKIPPED,
                "Cannot run coverage for unknown repo type",
            )

        cmd = self._get_coverage_command()
        try:
            print(f"Running coverage: {' '.join(cmd)}", file=sys.stderr)
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)

            # Go requires second command
            if self.repo_type == RepoType.GO and result.returncode == 0:
                subprocess.run(
                    ["go", "tool", "cover", "-func=coverage.out"],
                    capture_output=True,
                    text=True,
                    timeout=30,
                )

            if result.returncode != 0:
                return self._op_result(
                    "run_coverage",
                    OperationStatus.FAILED,
                    f"Coverage command failed: {result.stderr[:500]}",
                    {"returncode": result.returncode},
                )

            return self._op_result(
                "run_coverage",
                OperationStatus.SUCCESS,
                f"Coverage command completed: {self.repo_type.value}",
            )

        except subprocess.TimeoutExpired:
            return self._op_result(
                "run_coverage",
                OperationStatus.FAILED,
                "Coverage command timed out after 5 minutes",
            )
        except Exception as e:
            return self._op_result(
                "run_coverage", OperationStatus.FAILED, f"Failed to run coverage: {e}"
            )

    def _get_coverage_command(self) -> List[str]:
        """Get coverage command for detected repo type."""
        if self.repo_type not in FRAMEWORK_CONFIG:
            return []

        cmd = FRAMEWORK_CONFIG[self.repo_type]["command"].copy()

        # Check for uv in pytest
        if self.repo_type == RepoType.PYTEST:
            uv_available = (
                subprocess.run(
                    ["which", "uv"], capture_output=True, timeout=5
                ).returncode
                == 0
            )
            if uv_available:
                cmd = ["uv", "run"] + cmd

        return cmd

    def parse_coverage_report(self) -> OperationResult:
        """Parse coverage report based on repo type."""
        if self.dry_run:
            return self._dry_run_result(
                "parse_coverage_report", "parse coverage report"
            )

        if self.repo_type not in FRAMEWORK_CONFIG:
            return self._op_result(
                "parse_coverage_report",
                OperationStatus.SKIPPED,
                f"No parser for {self.repo_type}",
            )

        config = FRAMEWORK_CONFIG[self.repo_type]
        report_path = Path(config["report_path"])

        if not report_path.exists():
            return self._op_result(
                "parse_coverage_report",
                OperationStatus.FAILED,
                f"Coverage report not found: {report_path}",
            )

        try:
            report_format = config["report_format"]
            if report_format == "jest":
                self.coverage_data = self._parse_jest_report(report_path)
            elif report_format == "pytest":
                self.coverage_data = self._parse_pytest_report(report_path)
            elif report_format == "go":
                self.coverage_data = self._parse_go_report(report_path)

            return self._op_result(
                "parse_coverage_report",
                OperationStatus.SUCCESS,
                f"Parsed coverage: {self.coverage_data.percent_covered:.1f}% ({self.coverage_data.covered_lines}/{self.coverage_data.total_lines} lines)",
                {
                    "total_pct": self.coverage_data.percent_covered,
                    "files_count": len(self.coverage_data.files),
                },
            )

        except Exception as e:
            return self._op_result(
                "parse_coverage_report",
                OperationStatus.FAILED,
                f"Failed to parse coverage report: {e}",
            )

    def _parse_jest_report(self, path: Path) -> CoverageData:
        """Parse Jest/Vitest coverage-summary.json."""
        with open(path) as f:
            data = json.load(f)

        total = data.get("total", {})
        lines = total.get("lines", {})

        files = {}
        for file_path, file_data in data.items():
            if file_path == "total":
                continue
            file_lines = file_data.get("lines", {})
            files[file_path] = FileCoverage(
                total_lines=file_lines.get("total", 0),
                covered_lines=file_lines.get("covered", 0),
                percent_covered=file_lines.get("pct", 0.0),
            )

        return CoverageData(
            total_lines=lines.get("total", 0),
            covered_lines=lines.get("covered", 0),
            percent_covered=lines.get("pct", 0.0),
            files=files,
        )

    def _parse_pytest_report(self, path: Path) -> CoverageData:
        """Parse pytest coverage.json."""
        with open(path) as f:
            data = json.load(f)

        totals = data.get("totals", {})
        files = {}

        for file_path, file_data in data.get("files", {}).items():
            summary = file_data.get("summary", {})
            files[file_path] = FileCoverage(
                total_lines=summary.get("num_statements", 0),
                covered_lines=summary.get("covered_lines", 0),
                percent_covered=summary.get("percent_covered", 0.0),
                uncovered_lines=file_data.get("missing_lines", []),
            )

        return CoverageData(
            total_lines=totals.get("num_statements", 0),
            covered_lines=totals.get("covered_lines", 0),
            percent_covered=totals.get("percent_covered", 0.0),
            files=files,
        )

    def _parse_go_report(self, path: Path) -> CoverageData:
        """Parse Go coverage.out."""
        total_stmts = covered_stmts = 0

        with open(path) as f:
            for line in f:
                if line.startswith("mode:"):
                    continue
                parts = line.strip().split()
                if len(parts) >= 3:
                    num_stmts = int(parts[1])
                    count = int(parts[2])
                    total_stmts += num_stmts
                    if count > 0:
                        covered_stmts += num_stmts

        pct = (covered_stmts / total_stmts * 100) if total_stmts > 0 else 0.0
        return CoverageData(
            total_lines=total_stmts, covered_lines=covered_stmts, percent_covered=pct
        )

    def get_pr_diff(self) -> OperationResult:
        """Fetch PR diff to get changed files and line numbers."""
        if self.dry_run:
            return self._dry_run_result("get_pr_diff", "fetch PR diff")

        try:
            # Try GitHub
            result = subprocess.run(
                ["gh", "pr", "view", "--json", "number,files"],
                capture_output=True,
                text=True,
                timeout=30,
            )

            if result.returncode == 0:
                pr_data = json.loads(result.stdout)
                self.pr_number = str(pr_data["number"])
                diff_data = {
                    f.get("path", ""): self._parse_diff_lines(f.get("patch", ""))
                    for f in pr_data.get("files", [])
                    if f.get("patch")
                }

                return self._op_result(
                    "get_pr_diff",
                    OperationStatus.SUCCESS,
                    f"Fetched PR #{self.pr_number} diff ({len(diff_data)} files changed)",
                    {"pr_number": self.pr_number, "diff": diff_data},
                )

            return self._op_result(
                "get_pr_diff", OperationStatus.SKIPPED, "No PR found for current branch"
            )

        except Exception as e:
            return self._op_result(
                "get_pr_diff", OperationStatus.FAILED, f"Failed to fetch PR diff: {e}"
            )

    def _parse_diff_lines(self, patch: str) -> List[int]:
        """Extract added/modified line numbers from unified diff patch."""
        lines = []
        for line in patch.split("\n"):
            if line.startswith("@@"):
                match = re.search(r"\+(\d+),?(\d*)", line)
                if match:
                    start = int(match.group(1))
                    count = int(match.group(2) or "1")
                    lines.extend(range(start, start + count))
        return lines

    def calculate_diff_coverage(
        self, diff_data: Dict[str, List[int]]
    ) -> OperationResult:
        """Calculate coverage for changed lines only."""
        if self.dry_run:
            return self._dry_run_result(
                "calculate_diff_coverage", "calculate diff coverage"
            )

        if not self.coverage_data:
            return self._op_result(
                "calculate_diff_coverage",
                OperationStatus.FAILED,
                "No coverage data available",
            )

        total_changed = covered_changed = 0
        files_diff = {}

        for file_path, changed_lines in diff_data.items():
            file_cov = self.coverage_data.files.get(file_path)
            uncovered = (
                changed_lines
                if not file_cov
                else [
                    line for line in changed_lines if line in file_cov.uncovered_lines
                ]
            )

            total_file = len(changed_lines)
            covered_file = total_file - len(uncovered)
            pct = (covered_file / total_file * 100) if total_file > 0 else 100.0

            files_diff[file_path] = FileDiffCoverage(
                total_changed=total_file,
                covered_changed=covered_file,
                percent_covered=pct,
                uncovered_changed_lines=uncovered,
            )

            total_changed += total_file
            covered_changed += covered_file

        overall_pct = (
            (covered_changed / total_changed * 100) if total_changed > 0 else 100.0
        )
        self.diff_coverage_data = DiffCoverageData(
            total_changed_lines=total_changed,
            covered_changed_lines=covered_changed,
            percent_covered=overall_pct,
            files=files_diff,
        )

        return self._op_result(
            "calculate_diff_coverage",
            OperationStatus.SUCCESS,
            f"Diff coverage: {overall_pct:.1f}% ({covered_changed}/{total_changed} changed lines covered)",
            {"diff_pct": overall_pct},
        )

    def check_threshold(self) -> OperationResult:
        """Check if coverage meets threshold."""
        if self.dry_run:
            return self._dry_run_result(
                "check_threshold", f"check threshold: {self.threshold}%"
            )

        coverage_pct = (
            self.diff_coverage_data.percent_covered
            if self.diff_coverage_data
            else self.coverage_data.percent_covered
            if self.coverage_data
            else 0.0
        )

        met = coverage_pct >= self.threshold
        status = (
            OperationStatus.SUCCESS
            if met or not self.enforce
            else OperationStatus.FAILED
        )
        verb = "meets" if met else "below"

        return self._op_result(
            "check_threshold",
            status,
            f"Coverage {coverage_pct:.1f}% {verb} threshold {self.threshold}%",
            {"threshold_met": met},
        )

    def generate_report(self) -> str:
        """Generate markdown coverage report."""
        lines = ["## Test Coverage Report\n"]

        if self.coverage_data:
            icon = "✅" if self.coverage_data.percent_covered >= self.threshold else "⚠️"
            lines.extend(
                [
                    "### Overall Coverage",
                    f"- **Total**: {self.coverage_data.percent_covered:.1f}% ({self.coverage_data.covered_lines}/{self.coverage_data.total_lines} lines)",
                    f"- **Threshold**: {self.threshold:.0f}% {icon}\n",
                ]
            )

        if self.diff_coverage_data:
            icon = (
                "✅"
                if self.diff_coverage_data.percent_covered >= self.threshold
                else "⚠️"
            )
            lines.extend(
                [
                    "### Changed Lines Coverage (Diff)",
                    f"- **Total Changed**: {self.diff_coverage_data.total_changed_lines} lines",
                    f"- **Covered**: {self.diff_coverage_data.covered_changed_lines} lines ({self.diff_coverage_data.percent_covered:.1f}%) {icon}\n",
                ]
            )

            # Per-file table
            if self.diff_coverage_data.files:
                lines.extend(
                    [
                        "### Files",
                        "| File | Coverage | Changed Lines | Diff Coverage |",
                        "|------|----------|---------------|---------------|",
                    ]
                )

                for file_path, file_diff in self.diff_coverage_data.files.items():
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
                    icon = "✅" if file_diff.percent_covered >= self.threshold else "⚠️"
                    lines.append(
                        f"| `{file_path}` | {overall} | {file_diff.total_changed} | "
                        f"{file_diff.percent_covered:.0f}% ({file_diff.covered_changed}/{file_diff.total_changed}) {icon} |"
                    )

                # Uncovered lines
                uncovered = {
                    p: d.uncovered_changed_lines
                    for p, d in self.diff_coverage_data.files.items()
                    if d.uncovered_changed_lines
                }
                if uncovered:
                    lines.append("\n### Uncovered Changed Lines")
                    for file_path, unc_lines in uncovered.items():
                        lines.append(
                            f"- `{file_path}`: Lines {self._format_line_ranges(unc_lines)}"
                        )

        lines.extend(
            ["\n---", "🤖 Generated by [Claude Code](https://claude.com/claude-code)"]
        )
        return "\n".join(lines)

    def _format_line_ranges(self, lines: List[int]) -> str:
        """Format list of line numbers as ranges (e.g., '1-3, 5, 7-9')."""
        if not lines:
            return ""

        lines = sorted(set(lines))
        ranges = []
        start = end = lines[0]

        for line in lines[1:]:
            if line == end + 1:
                end = line
            else:
                ranges.append(str(start) if start == end else f"{start}-{end}")
                start = end = line

        ranges.append(str(start) if start == end else f"{start}-{end}")
        return ", ".join(ranges)

    def post_pr_comment(self, report: str) -> OperationResult:
        """Post coverage report as PR comment."""
        if self.dry_run:
            return self._dry_run_result("post_pr_comment", "post PR comment")

        if not self.pr_number:
            return self._op_result(
                "post_pr_comment", OperationStatus.SKIPPED, "No PR number available"
            )

        try:
            result = subprocess.run(
                ["gh", "pr", "comment", self.pr_number, "--body", report],
                capture_output=True,
                text=True,
                timeout=30,
            )

            if result.returncode == 0:
                return self._op_result(
                    "post_pr_comment",
                    OperationStatus.SUCCESS,
                    f"Posted coverage report to PR #{self.pr_number}",
                )
            else:
                return self._op_result(
                    "post_pr_comment",
                    OperationStatus.FAILED,
                    f"Failed to post PR comment: {result.stderr}",
                )

        except Exception as e:
            return self._op_result(
                "post_pr_comment",
                OperationStatus.FAILED,
                f"Failed to post PR comment: {e}",
            )

    def store_metrics(self) -> OperationResult:
        """Store coverage metrics to memory server."""
        if self.dry_run:
            return self._dry_run_result("store_metrics", "store coverage metrics")

        if not HAS_HTTPX:
            return self._op_result(
                "store_metrics", OperationStatus.SKIPPED, "httpx not available"
            )

        memory_url = os.environ.get("BOT_MEMORY_URL", "").rstrip("/")
        if not memory_url:
            return self._op_result(
                "store_metrics", OperationStatus.SKIPPED, "BOT_MEMORY_URL not set"
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

            # Get repo name
            result = subprocess.run(
                ["git", "remote", "get-url", "origin"],
                capture_output=True,
                text=True,
                timeout=10,
            )
            repo_name = (
                result.stdout.strip().split("/")[-1].replace(".git", "")
                if result.returncode == 0
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
                return self._op_result(
                    "store_metrics",
                    OperationStatus.SUCCESS,
                    "Stored coverage metrics to memory",
                )
            else:
                return self._op_result(
                    "store_metrics",
                    OperationStatus.FAILED,
                    f"Failed to store metrics: HTTP {response.status_code}",
                )

        except Exception as e:
            return self._op_result(
                "store_metrics",
                OperationStatus.SKIPPED,
                f"Could not store metrics: {e}",
            )

    def execute_workflow(self) -> WorkflowResult:
        """Execute full coverage evaluation workflow."""
        operations = []

        # 1. Detect repository type
        result = self.detect_repo_type()
        operations.append(result)
        if result.status == OperationStatus.FAILED:
            return WorkflowResult(False, operations)

        # 2. Run coverage
        result = self.run_coverage()
        operations.append(result)
        if result.status == OperationStatus.FAILED:
            return WorkflowResult(False, operations)

        # 3. Parse coverage report
        result = self.parse_coverage_report()
        operations.append(result)
        if result.status == OperationStatus.FAILED:
            return WorkflowResult(False, operations)

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
                return WorkflowResult(False, operations)

        # 6. Check threshold
        result = self.check_threshold()
        operations.append(result)
        threshold_met = (
            result.details.get("threshold_met", False) if result.details else False
        )

        if result.status == OperationStatus.FAILED and self.enforce:
            return WorkflowResult(
                False, operations, self.coverage_data, self.diff_coverage_data, False
            )

        # 7. Generate and post report (if requested)
        if self.pr_comment:
            report = self.generate_report()
            result = self.post_pr_comment(report)
            operations.append(result)

        # 8. Store metrics
        result = self.store_metrics()
        operations.append(result)

        return WorkflowResult(
            True, operations, self.coverage_data, self.diff_coverage_data, threshold_met
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
        "--diff-only", action="store_true", help="Only check coverage for changed lines"
    )
    parser.add_argument(
        "--pr-comment", action="store_true", help="Post coverage report as PR comment"
    )
    parser.add_argument(
        "--enforce", action="store_true", help="Exit 1 if threshold not met (for CI)"
    )
    parser.add_argument(
        "--dry-run", action="store_true", help="Preview without executing"
    )

    args = parser.parse_args()

    ops = CoverageOperations(
        threshold=args.threshold,
        diff_only=args.diff_only,
        pr_comment=args.pr_comment,
        enforce=args.enforce,
        dry_run=args.dry_run,
    )

    result = ops.execute_workflow()

    # Print operation results
    icons = {
        OperationStatus.SUCCESS: "✓",
        OperationStatus.FAILED: "✗",
        OperationStatus.SKIPPED: "○",
    }
    for op in result.operations:
        print(f"{icons[op.status]} [{op.operation}] {op.message}")

    # Print coverage report
    if result.coverage_data and not args.pr_comment:
        print("\n" + ops.generate_report())

    sys.exit(0 if result.success and result.threshold_met else 1)


if __name__ == "__main__":
    main()
