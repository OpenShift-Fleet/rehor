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


@dataclass
class OperationResult:
    """Result of an operation with success status and optional data."""

    success: bool
    message: str
    data: dict | None = None


@dataclass
class RepositoryConfig:
    """Repository configuration detected from project-repos.json or git remotes."""

    repo_type: str  # "github" or "gitlab"
    is_fork: bool
    upstream: str | None = None  # e.g., "RedHatInsights/hcc-ai-assistant"
    fork: str | None = None  # e.g., "catastrophe-brandon/hcc-ai-assistant"
    upstream_url: str | None = None
    fork_url: str | None = None
    origin: str | None = None  # owner/repo of the local checkout's primary remote


PR_TEMPLATE_PATHS = [
    ".github/pull_request_template.md",
    ".github/PULL_REQUEST_TEMPLATE.md",
    "pull_request_template.md",
    "PULL_REQUEST_TEMPLATE.md",
    ".github/PULL_REQUEST_TEMPLATE/default.md",
]


class PushAndPROperations:
    """Handles push and PR creation operations."""

    def __init__(self, title: str, body: str, dry_run: bool = False, cwd: Path | None = None):
        self.title = title
        self.body = body
        self.dry_run = dry_run
        self.cwd = cwd
        self.repo_config: RepositoryConfig | None = None
        self.current_branch: str | None = None
        self.pr_url: str | None = None
        self.pr_number: str | None = None

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
            return OperationResult(False, f"detect_repository failed: {e!s}")

    def _find_project_repos_json(self) -> Path | None:
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
            with open(config_path) as f:
                config = json.load(f)

            # Extract repo name from current directory
            repo_name = Path.cwd().name

            if repo_name not in config:
                return OperationResult(False, f"Repository '{repo_name}' not found in {config_path}")

            repo_config = config[repo_name]
            repo_type = repo_config.get("type", "github")

            # Accept both "fork"/"upstream" (owner/repo) and "url"/"upstream"
            # (full git URLs) key styles; normalize everything to owner/repo.
            raw_fork = repo_config.get("fork") or repo_config.get("url")
            raw_upstream = repo_config.get("upstream")
            fork = self._normalize_repo_ref(raw_fork) if raw_fork else None
            upstream = self._normalize_repo_ref(raw_upstream) if raw_upstream else None

            self.repo_config = RepositoryConfig(
                repo_type=repo_type,
                is_fork=bool(fork and upstream and fork != upstream),
                upstream=upstream,
                fork=fork,
                origin=fork or upstream,
            )

            return OperationResult(
                True,
                f"Detected {repo_type} {'fork' if self.repo_config.is_fork else 'direct'} from {config_path}",
                data={"repo_type": repo_type, "is_fork": self.repo_config.is_fork, "upstream": upstream, "fork": fork},
            )

        except Exception as e:
            return OperationResult(False, f"Failed to parse {config_path}: {e!s}")

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
                origin=origin_owner_repo,
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
            return OperationResult(False, f"Failed to detect from remotes: {e!s}")

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

    def _normalize_repo_ref(self, value: str) -> str:
        """Normalize a repo reference to owner/repo.

        Accepts either "owner/repo" or a full git URL (SSH/HTTPS).
        """
        if "://" in value or value.startswith("git@"):
            return self._extract_owner_repo(value)
        return value

    def _stdout_text(self, result: subprocess.CompletedProcess) -> str:
        """Return command stdout as text regardless of bytes/str."""
        out = result.stdout
        if isinstance(out, bytes):
            return (out or b"").decode(errors="replace")
        return out or ""

    def _stdout_json(self, result: subprocess.CompletedProcess) -> dict:
        """Parse JSON from command stdout; empty dict on failure."""
        try:
            return json.loads(self._stdout_text(result) or "{}")
        except json.JSONDecodeError:
            return {}

    @staticmethod
    def find_pr_template(repo_dir: Path | None = None) -> OperationResult:
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
            return OperationResult(False, f"sync_fork failed: {e!s}")

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
            return OperationResult(False, f"push_branch failed: {e!s}")

    def create_pr(self) -> OperationResult:
        """
        Create pull/merge request with correct flags.

        Uses the gh/glab REST APIs for GitHub/GitLab. The repo-context
        subcommands (`gh pr create`/`glab mr create`) cannot run through the
        executor thin client.
        Handles fork scenario with an explicit head ref (GitHub) or the
        upstream target project (GitLab).

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
            return OperationResult(False, f"create_pr failed: {e!s}")

    def _create_github_pr(self) -> OperationResult:
        """Create GitHub PR via the REST API.

        `gh pr create` cannot be used: gh is a thin client executing in the
        remote executor container with no access to the sandbox repo, so it
        cannot resolve repo/branch context. Explicit `gh api` calls need no
        repo context.
        """
        if self.repo_config.is_fork:
            # POST repos/<upstream>/pulls head=<fork-owner>:<branch>
            if not self.repo_config.upstream or not self.repo_config.fork:
                return OperationResult(False, "Upstream and fork repositories required for fork workflow")

            target = self.repo_config.upstream
            head = f"{self.repo_config.fork.split('/')[0]}:{self.current_branch}"
        else:
            # POST repos/<origin>/pulls head=<branch>
            target = self.repo_config.origin or self.repo_config.upstream
            if not target:
                if self.dry_run:
                    target = "<owner/repo>"
                else:
                    return OperationResult(False, "Target repository not detected for direct push")
            head = self.current_branch

        # Resolve default branch for the base ref (gh pr create used to infer it).
        branch_result = self._run_command(["gh", "api", f"repos/{target}", "--jq", ".default_branch"], check=False)
        base = self._stdout_text(branch_result).strip()
        if not base and self.dry_run:
            base = "main"
        if not base:
            stderr = branch_result.stderr if isinstance(branch_result.stderr, str) else ""
            return OperationResult(False, f"gh api failed to resolve default branch for {target}: {stderr}")

        cmd = [
            "gh",
            "api",
            f"repos/{target}/pulls",
            "-X",
            "POST",
            "-f",
            f"title={self.title}",
            "-f",
            f"body={self.body}",
            "-f",
            f"head={head}",
            "-f",
            f"base={base}",
        ]

        result = self._run_command(cmd, check=False)

        if self.dry_run:
            return OperationResult(True, "Created PR (dry run)", data={"pr_url": None, "pr_number": None})

        if result.returncode != 0:
            stderr = result.stderr if isinstance(result.stderr, str) else ""
            return OperationResult(False, f"gh api create PR failed: {stderr}")

        payload = self._stdout_json(result)
        pr_url = payload.get("html_url")
        pr_number = payload.get("number")
        if not pr_url or not pr_number:
            return OperationResult(False, "gh api create PR returned no PR URL/number")

        self.pr_url = pr_url
        self.pr_number = str(pr_number)

        return OperationResult(
            True,
            f"Created PR #{pr_number}",
            data={"pr_url": pr_url, "pr_number": str(pr_number)},
        )

    def _create_gitlab_mr(self) -> OperationResult:
        """Create GitLab MR via the REST API.

        `glab mr create` cannot be used: glab is a thin client executing in
        the remote executor container with no access to the sandbox repo.
        """
        target = self.repo_config.upstream if self.repo_config.is_fork else self.repo_config.origin
        if not target:
            if self.dry_run:
                target = "<owner/repo>"
            else:
                return OperationResult(False, "Target project not detected")

        encoded = target.replace("/", "%2F")

        # Resolve default branch for the target ref.
        branch_result = self._run_command(
            ["glab", "api", f"projects/{encoded}", "--hostname", "gitlab.cee.redhat.com"],
            check=False,
        )
        base = str(self._stdout_json(branch_result).get("default_branch") or "")
        if not base and self.dry_run:
            base = "main"
        if not base:
            return OperationResult(False, f"glab api failed to resolve default branch for {target}")

        cmd = [
            "glab",
            "api",
            f"projects/{encoded}/merge_requests",
            "-X",
            "POST",
            "-f",
            f"source_branch={self.current_branch}",
            "-f",
            f"target_branch={base}",
            "-f",
            f"title={self.title}",
            "-f",
            f"description={self.body}",
            "--hostname",
            "gitlab.cee.redhat.com",
        ]

        result = self._run_command(cmd, check=False)

        if self.dry_run:
            return OperationResult(True, "Created MR (dry run)", data={"pr_url": None, "pr_number": None})

        if result.returncode != 0:
            stderr = result.stderr if isinstance(result.stderr, str) else ""
            return OperationResult(False, f"glab api create MR failed: {stderr}")

        payload = self._stdout_json(result)
        mr_url = payload.get("web_url")
        mr_number = payload.get("iid")
        if not mr_url or not mr_number:
            return OperationResult(False, "glab api create MR returned no MR URL/iid")

        self.pr_url = mr_url
        self.pr_number = str(mr_number)

        return OperationResult(
            True,
            f"Created MR !{mr_number}",
            data={"pr_url": mr_url, "pr_number": str(mr_number)},
        )


def execute_push_and_pr_workflow(title: str, body: str, dry_run: bool = False, cwd: Path | None = None) -> int:
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
