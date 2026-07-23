"""
Push and PR Operations

Handles git push (with proper credential helper) and PR creation in a single workflow.
Supports both GitHub (gh) and GitLab (glab) with fork detection.
"""

import argparse
import json
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Optional


@dataclass
class OperationResult:
    """Result of an operation with success status and optional data."""

    success: bool
    message: str
    data: Optional[dict] = None


@dataclass
class RepositoryConfig:
    """Repository configuration detected from project-repos.json or git remotes."""

    repo_type: str  # "github" or "gitlab"
    is_fork: bool
    upstream: Optional[str] = None  # e.g., "RedHatInsights/hcc-ai-assistant"
    fork: Optional[str] = None  # e.g., "catastrophe-brandon/hcc-ai-assistant"
    upstream_url: Optional[str] = None
    fork_url: Optional[str] = None


PR_TEMPLATE_PATHS = [
    ".github/pull_request_template.md",
    ".github/PULL_REQUEST_TEMPLATE.md",
    "pull_request_template.md",
    "PULL_REQUEST_TEMPLATE.md",
    ".github/PULL_REQUEST_TEMPLATE/default.md",
]


class PushAndPROperations:
    """Handles push and PR creation operations."""

    def __init__(self, title: str, body: str, dry_run: bool = False, cwd: Optional[Path] = None):
        self.title = title
        self.body = body
        self.dry_run = dry_run
        self.cwd = cwd
        self.repo_config: Optional[RepositoryConfig] = None
        self.current_branch: Optional[str] = None
        self.pr_url: Optional[str] = None
        self.pr_number: Optional[str] = None

    def _run_command(
        self, cmd: list[str], capture_output: bool = True, check: bool = True
    ) -> subprocess.CompletedProcess:
        """Run a shell command with optional dry-run mode."""
        if self.dry_run:
            print(f"[DRY RUN] Would execute: {' '.join(cmd)}")
            return subprocess.CompletedProcess(cmd, 0, stdout=b"", stderr=b"")

        result = subprocess.run(cmd, capture_output=capture_output, text=True, check=check, cwd=self.cwd)
        return result

    def detect_repository(self) -> OperationResult:
        """
        Detect repository type and configuration.

        Checks for project-repos.json in current directory or parent,
        falls back to inspecting git remotes.

        Returns:
            OperationResult with repo_config data
        """
        try:
            # Get current branch
            result = self._run_command(["git", "rev-parse", "--abbrev-ref", "HEAD"])
            self.current_branch = result.stdout.strip() if result.stdout else None

            if not self.current_branch:
                return OperationResult(False, "Failed to detect current branch")

            # Try to find project-repos.json
            config_path = self._find_project_repos_json()
            if config_path:
                return self._detect_from_config(config_path)
            else:
                return self._detect_from_remotes()

        except subprocess.CalledProcessError as e:
            return OperationResult(False, f"detect_repository failed: {e.stderr}")
        except Exception as e:
            return OperationResult(False, f"detect_repository failed: {str(e)}")

    def _find_project_repos_json(self) -> Optional[Path]:
        """Find project-repos.json in current directory or parent."""
        current = Path.cwd()
        for _ in range(3):  # Check current and up to 2 parent directories
            config_file = current / "project-repos.json"
            if config_file.exists():
                return config_file
            if current.parent == current:
                break
            current = current.parent
        return None

    def _detect_from_config(self, config_path: Path) -> OperationResult:
        """Detect repository configuration from project-repos.json."""
        try:
            with open(config_path, "r") as f:
                config = json.load(f)

            # Extract repo name from current directory
            repo_name = Path.cwd().name

            if repo_name not in config:
                return OperationResult(False, f"Repository '{repo_name}' not found in {config_path}")

            repo_config = config[repo_name]
            repo_type = repo_config.get("type", "github")
            upstream = repo_config.get("upstream")
            fork = repo_config.get("fork")

            self.repo_config = RepositoryConfig(repo_type=repo_type, is_fork=bool(fork), upstream=upstream, fork=fork)

            return OperationResult(
                True,
                f"Detected {repo_type} {'fork' if self.repo_config.is_fork else 'direct'} from {config_path}",
                data={"repo_type": repo_type, "is_fork": self.repo_config.is_fork, "upstream": upstream, "fork": fork},
            )

        except Exception as e:
            return OperationResult(False, f"Failed to parse {config_path}: {str(e)}")

    def _detect_from_remotes(self) -> OperationResult:
        """Detect repository configuration from git remotes."""
        try:
            result = self._run_command(["git", "remote", "-v"])
            remotes = result.stdout if result.stdout else ""

            # Parse remotes
            origin_url = None
            upstream_url = None

            for line in remotes.split("\n"):
                if not line.strip():
                    continue
                parts = line.split()
                if len(parts) < 2:
                    continue
                remote_name, url = parts[0], parts[1]

                if remote_name == "origin":
                    origin_url = url
                elif remote_name == "upstream":
                    upstream_url = url

            if not origin_url:
                return OperationResult(False, "No 'origin' remote found")

            # Detect repo type
            if "github.com" in origin_url:
                repo_type = "github"
            elif "gitlab.cee.redhat.com" in origin_url:
                repo_type = "gitlab"
            else:
                return OperationResult(False, f"Unsupported remote URL: {origin_url}")

            # Detect if fork
            is_fork = upstream_url is not None

            # Extract owner/repo from URLs
            origin_owner_repo = self._extract_owner_repo(origin_url)
            upstream_owner_repo = self._extract_owner_repo(upstream_url) if upstream_url else None

            self.repo_config = RepositoryConfig(
                repo_type=repo_type,
                is_fork=is_fork,
                upstream=upstream_owner_repo,
                fork=origin_owner_repo if is_fork else None,
                upstream_url=upstream_url,
                fork_url=origin_url if is_fork else None,
            )

            return OperationResult(
                True,
                f"Detected {repo_type} {'fork' if is_fork else 'direct'} from git remotes",
                data={
                    "repo_type": repo_type,
                    "is_fork": is_fork,
                    "upstream": upstream_owner_repo,
                    "fork": origin_owner_repo if is_fork else None,
                },
            )

        except subprocess.CalledProcessError as e:
            return OperationResult(False, f"Failed to inspect git remotes: {e.stderr}")
        except Exception as e:
            return OperationResult(False, f"Failed to detect from remotes: {str(e)}")

    def _extract_owner_repo(self, url: str) -> str:
        """Extract owner/repo from git URL."""
        # Handle both SSH and HTTPS URLs
        # SSH: git@github.com:owner/repo.git
        # HTTPS: https://github.com/owner/repo.git
        if url.startswith("git@"):
            # SSH format
            parts = url.split(":")
            if len(parts) == 2:
                owner_repo = parts[1].replace(".git", "")
                return owner_repo
        elif url.startswith("http"):
            # HTTPS format
            parts = url.split("/")
            if len(parts) >= 2:
                owner_repo = "/".join(parts[-2:]).replace(".git", "")
                return owner_repo

        return url  # Fallback to original URL

    @staticmethod
    def find_pr_template(repo_dir: Optional[Path] = None) -> OperationResult:
        """
        Search for a PR template in the repository.

        Checks common locations in priority order and returns the first match.

        Args:
            repo_dir: Directory to search in. Defaults to cwd.

        Returns:
            OperationResult with data={"path": str, "content": str} if found,
            or data={"path": None} if no template exists.
        """
        base = repo_dir or Path.cwd()
        for template_path in PR_TEMPLATE_PATHS:
            full_path = base / template_path
            if full_path.is_file():
                try:
                    content = full_path.read_text(encoding="utf-8")
                    return OperationResult(
                        True,
                        f"Found PR template at {template_path}",
                        data={"path": str(template_path), "content": content},
                    )
                except OSError as e:
                    return OperationResult(False, f"Failed to read {template_path}: {e}")

        return OperationResult(True, "No PR template found", data={"path": None})

    def sync_fork(self) -> OperationResult:
        """
        Sync fork with upstream (only if using a fork).

        Uses gh repo sync for GitHub or glab repo sync for GitLab.

        Returns:
            OperationResult indicating success
        """
        if not self.repo_config:
            return OperationResult(False, "Repository configuration not detected. Run detect_repository first.")

        if not self.repo_config.is_fork:
            return OperationResult(True, "Not a fork, skipping sync", data={"skipped": True})

        try:
            if self.repo_config.repo_type == "github":
                # gh repo sync owner/fork
                if not self.repo_config.fork:
                    return OperationResult(False, "Fork repository not specified")

                cmd = ["gh", "repo", "sync", self.repo_config.fork]
                result = self._run_command(cmd, check=False)

                if result.returncode != 0:
                    # gh repo sync might fail if already up-to-date, check stderr
                    stderr = result.stderr if result.stderr else ""
                    if "up to date" in stderr.lower() or "already up-to-date" in stderr.lower():
                        return OperationResult(True, "Fork already up-to-date")
                    return OperationResult(False, f"gh repo sync failed: {stderr}")

                return OperationResult(True, f"Synced fork {self.repo_config.fork}")

            elif self.repo_config.repo_type == "gitlab":
                # glab repo sync
                cmd = ["glab", "repo", "sync"]
                result = self._run_command(cmd, check=False)

                if result.returncode != 0:
                    stderr = result.stderr if result.stderr else ""
                    if "up to date" in stderr.lower() or "already up-to-date" in stderr.lower():
                        return OperationResult(True, "Fork already up-to-date")
                    return OperationResult(False, f"glab repo sync failed: {stderr}")

                return OperationResult(True, "Synced fork with upstream")

            else:
                return OperationResult(False, f"Unsupported repo type: {self.repo_config.repo_type}")

        except subprocess.CalledProcessError as e:
            return OperationResult(False, f"sync_fork failed: {e.stderr}")
        except Exception as e:
            return OperationResult(False, f"sync_fork failed: {str(e)}")

    def push_branch(self) -> OperationResult:
        """
        Push current branch with proper credential helper.

        Uses gh/glab auth git-credential as credential helper.

        Returns:
            OperationResult indicating success
        """
        if not self.repo_config:
            return OperationResult(False, "Repository configuration not detected. Run detect_repository first.")

        if not self.current_branch:
            return OperationResult(False, "Current branch not detected")

        try:
            if self.repo_config.repo_type == "github":
                credential_helper = "!gh auth git-credential"
            elif self.repo_config.repo_type == "gitlab":
                credential_helper = "!glab auth git-credential"
            else:
                return OperationResult(False, f"Unsupported repo type: {self.repo_config.repo_type}")

            # git -c credential.helper='...' push origin <branch> -u
            cmd = [
                "git",
                "-c",
                f"credential.helper={credential_helper}",
                "push",
                "origin",
                self.current_branch,
                "-u",
            ]

            result = self._run_command(cmd, check=False)

            if result.returncode != 0:
                stderr = result.stderr if result.stderr else ""
                # Check if branch is already up-to-date
                if "up-to-date" in stderr.lower() or "everything up-to-date" in stderr.lower():
                    return OperationResult(True, f"Branch {self.current_branch} already up-to-date")
                return OperationResult(False, f"git push failed: {stderr}")

            # Check stdout/stderr for "up-to-date" message even when returncode is 0
            stdout = result.stdout if result.stdout else ""
            stderr = result.stderr if result.stderr else ""
            if "up-to-date" in stdout.lower() or "up-to-date" in stderr.lower():
                return OperationResult(True, f"Branch {self.current_branch} already up-to-date")

            return OperationResult(True, f"Pushed branch {self.current_branch} to origin")

        except subprocess.CalledProcessError as e:
            return OperationResult(False, f"push_branch failed: {e.stderr}")
        except Exception as e:
            return OperationResult(False, f"push_branch failed: {str(e)}")

    def create_pr(self) -> OperationResult:
        """
        Create pull/merge request with correct flags.

        Uses gh pr create for GitHub or glab mr create for GitLab.
        Handles fork scenario with --head flag (GitHub) or proper remote (GitLab).

        Returns:
            OperationResult with pr_url and pr_number
        """
        if not self.repo_config:
            return OperationResult(False, "Repository configuration not detected. Run detect_repository first.")

        if not self.current_branch:
            return OperationResult(False, "Current branch not detected")

        try:
            if self.repo_config.repo_type == "github":
                return self._create_github_pr()
            elif self.repo_config.repo_type == "gitlab":
                return self._create_gitlab_mr()
            else:
                return OperationResult(False, f"Unsupported repo type: {self.repo_config.repo_type}")

        except subprocess.CalledProcessError as e:
            return OperationResult(False, f"create_pr failed: {e.stderr}")
        except Exception as e:
            return OperationResult(False, f"create_pr failed: {str(e)}")

    def _create_github_pr(self) -> OperationResult:
        """Create GitHub PR with gh pr create."""
        if self.repo_config.is_fork:
            # gh pr create --repo <upstream> --head <fork>:<branch> --title <title> --body <body>
            if not self.repo_config.upstream or not self.repo_config.fork:
                return OperationResult(False, "Upstream and fork repositories required for fork workflow")

            cmd = [
                "gh",
                "pr",
                "create",
                "--repo",
                self.repo_config.upstream,
                "--head",
                f"{self.repo_config.fork.split('/')[0]}:{self.current_branch}",
                "--title",
                self.title,
                "--body",
                self.body,
            ]
        else:
            # gh pr create --title <title> --body <body>
            cmd = ["gh", "pr", "create", "--title", self.title, "--body", self.body]

        result = self._run_command(cmd, check=False)

        if result.returncode != 0:
            stderr = result.stderr if result.stderr else ""
            return OperationResult(False, f"gh pr create failed: {stderr}")

        # Parse PR URL from stdout
        stdout = result.stdout if result.stdout else ""
        pr_url = stdout.strip().split("\n")[-1] if stdout else None

        # Extract PR number from URL
        pr_number = None
        if pr_url and "/pull/" in pr_url:
            pr_number = pr_url.split("/pull/")[-1]

        self.pr_url = pr_url
        self.pr_number = pr_number

        return OperationResult(
            True,
            f"Created PR #{pr_number}" if pr_number else "Created PR",
            data={"pr_url": pr_url, "pr_number": pr_number},
        )

    def _create_gitlab_mr(self) -> OperationResult:
        """Create GitLab MR with glab mr create."""
        # glab mr create --hostname gitlab.cee.redhat.com --title <title> --description <body>
        cmd = [
            "glab",
            "mr",
            "create",
            "--hostname",
            "gitlab.cee.redhat.com",
            "--title",
            self.title,
            "--description",
            self.body,
        ]

        result = self._run_command(cmd, check=False)

        if result.returncode != 0:
            stderr = result.stderr if result.stderr else ""
            return OperationResult(False, f"glab mr create failed: {stderr}")

        # Parse MR URL from stdout
        stdout = result.stdout if result.stdout else ""
        mr_url = None
        mr_number = None

        for line in stdout.split("\n"):
            if "merge_requests/" in line or "!=" in line:
                mr_url = line.strip()
                # Extract MR number
                if "!" in line:
                    parts = line.split("!")
                    if len(parts) > 1:
                        mr_number = parts[1].split()[0]

        self.pr_url = mr_url
        self.pr_number = mr_number

        return OperationResult(
            True,
            f"Created MR !{mr_number}" if mr_number else "Created MR",
            data={"pr_url": mr_url, "pr_number": mr_number},
        )


def execute_push_and_pr_workflow(title: str, body: str, dry_run: bool = False, cwd: Optional[Path] = None) -> int:
    """
    Execute the complete push and PR workflow.

    Args:
        title: PR title
        body: PR body/description
        dry_run: If True, print commands without executing
        cwd: Working directory to run commands in

    Returns:
        0 for success, 1 for failure
    """
    ops = PushAndPROperations(title=title, body=body, dry_run=dry_run, cwd=cwd)

    # Operation 1: Detect repository
    print("[1/4] Detecting repository configuration...")
    result = ops.detect_repository()
    if not result.success:
        print(f"❌ {result.message}")
        return 1
    print(f"✓ {result.message}")

    # Operation 2: Sync fork (if applicable)
    print("[2/4] Syncing fork with upstream...")
    result = ops.sync_fork()
    if not result.success:
        print(f"❌ {result.message}")
        return 1
    print(f"✓ {result.message}")

    # Operation 3: Push branch
    print("[3/4] Pushing branch to origin...")
    result = ops.push_branch()
    if not result.success:
        print(f"❌ {result.message}")
        return 1
    print(f"✓ {result.message}")

    # Operation 4: Create PR
    print("[4/4] Creating pull/merge request...")
    result = ops.create_pr()
    if not result.success:
        print(f"❌ {result.message}")
        return 1
    print(f"✓ {result.message}")

    # Print PR URL
    if ops.pr_url:
        print(f"\n🎉 PR created: {ops.pr_url}")
    else:
        print("\n🎉 PR created successfully")

    return 0


def main():
    """CLI entrypoint for the push-and-pr skill."""
    parser = argparse.ArgumentParser(description="Push branch and create PR/MR")
    parser.add_argument("title", nargs="?", help="PR/MR title")
    parser.add_argument("body", nargs="?", help="PR/MR body/description")
    parser.add_argument("--dry-run", action="store_true", help="Print commands without executing")
    parser.add_argument(
        "--find-template",
        action="store_true",
        help="Find and print the repo's PR template, then exit. Exit 0 if found, 1 if not.",
    )

    args = parser.parse_args()

    if args.find_template:
        result = PushAndPROperations.find_pr_template()
        if result.success and result.data and result.data.get("path"):
            print(result.data["content"], end="")
            sys.exit(0)
        else:
            print(result.message, file=sys.stderr)
            sys.exit(1)

    if not args.title or not args.body:
        parser.error("title and body are required when not using --find-template")

    exit_code = execute_push_and_pr_workflow(title=args.title, body=args.body, dry_run=args.dry_run)
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
