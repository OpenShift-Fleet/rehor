#!/usr/bin/env python3
"""
Auto-fork workflow for repos in project-repos.json.

Detects repos without forks, creates forks under bot's GitHub account,
and updates project-repos.json locally. After committing changes, use
push-and-pr skill to create the PR.

Operations:
1. detect_unforkable_repos - scan for repos needing forks
2. fork_repos - create forks using gh repo fork
3. update_and_commit - update project-repos.json and commit changes

After this script completes, use push-and-pr skill to create the PR.
GitLab repos are skipped with logged notice.
"""

import argparse
import json
import logging
import os
import subprocess
import sys
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

# Configure logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)

# Reuse existing config repo locations from bot/run.py
SCRIPT_DIR = Path(__file__).resolve().parent.parent.parent.parent
DATA_DIR = SCRIPT_DIR / "data"
REMOTE_CONFIG_DIR = DATA_DIR / "remote-config"


class OperationStatus(Enum):
    """Status of an individual operation."""

    SUCCESS = "success"
    FAILED = "failed"
    SKIPPED = "skipped"


@dataclass
class OperationResult:
    """Result of a single operation."""

    operation: str
    status: OperationStatus
    message: str
    details: Optional[Dict[str, Any]] = None


@dataclass
class RepoInfo:
    """Info about a repo needing a fork."""

    name: str
    upstream: str
    current_url: Optional[str]
    host: str  # "github" or "gitlab"
    needs_fork: bool


class AutoForkOperations:
    """Handles auto-fork operations."""

    def __init__(self, dry_run: bool = False):
        """
        Initialize auto-fork handler.

        Args:
            dry_run: If True, log actions without executing them
        """
        self.dry_run = dry_run
        self.bot_username = os.environ.get("BOT_GITHUB_USERNAME", "")
        self.config_repo_url = os.environ.get("BOT_CONFIG_REPO", "")
        self.instance_id = os.environ.get("BOT_INSTANCE_ID", "")
        self.config_path = os.environ.get("BOT_CONFIG_PATH", "rehor-config")

        # Determine config directory
        # Use remote-config if it exists (bot runtime), else fall back to local config
        if REMOTE_CONFIG_DIR.exists() and (REMOTE_CONFIG_DIR / self.config_path).exists():
            self.config_dir = REMOTE_CONFIG_DIR
            logger.info(f"Using remote config at {self.config_dir}")
        else:
            self.config_dir = SCRIPT_DIR / self.config_path
            logger.info(f"Using local config at {self.config_dir}")

        self.agent_dir = (
            self.config_dir / self.config_path / "agent"
            if self.config_dir == REMOTE_CONFIG_DIR
            else self.config_dir / "agent"
        )
        self.project_repos_path = self.agent_dir / "project-repos.json"

        # State
        self.repos_to_fork: List[RepoInfo] = []
        self.forked_repos: Dict[str, str] = {}  # name -> fork_url

    def detect_unforkable_repos(self) -> OperationResult:
        """
        Scan project-repos.json for repos needing forks.

        A repo needs a fork if:
        - It has an 'upstream' field
        - Its 'url' field doesn't match bot's account pattern
        - It's a GitHub repo (GitLab skipped for now)

        Returns:
            OperationResult with list of repos needing forks
        """
        if not self.bot_username:
            error_msg = "BOT_GITHUB_USERNAME env var not set"
            logger.error(error_msg)
            return OperationResult(
                operation="detect_unforkable_repos",
                status=OperationStatus.FAILED,
                message=error_msg,
            )

        if not self.project_repos_path.exists():
            error_msg = f"project-repos.json not found at {self.project_repos_path}"
            logger.error(error_msg)
            return OperationResult(
                operation="detect_unforkable_repos",
                status=OperationStatus.FAILED,
                message=error_msg,
            )

        logger.info(f"Scanning {self.project_repos_path} for repos needing forks...")

        try:
            with open(self.project_repos_path) as f:
                repos_config = json.load(f)
        except Exception as e:
            error_msg = f"Failed to parse project-repos.json: {e}"
            logger.error(error_msg)
            return OperationResult(
                operation="detect_unforkable_repos",
                status=OperationStatus.FAILED,
                message=error_msg,
            )

        repos_to_fork = []
        gitlab_repos = []

        for name, config in repos_config.items():
            upstream = config.get("upstream")
            current_url = config.get("url")
            host = config.get("host", "github")  # default to github

            if not upstream:
                continue  # No upstream = not a fork, skip

            # Check if URL already points to bot's fork
            if current_url and self.bot_username in current_url:
                logger.debug(f"{name}: already forked to {self.bot_username}")
                continue

            # Determine host from upstream URL if not specified
            if "gitlab" in upstream.lower():
                host = "gitlab"
            elif "github" in upstream.lower():
                host = "github"

            repo_info = RepoInfo(
                name=name,
                upstream=upstream,
                current_url=current_url,
                host=host,
                needs_fork=host == "github",  # Only auto-fork GitHub for now
            )

            if host == "gitlab":
                gitlab_repos.append(repo_info)
            else:
                repos_to_fork.append(repo_info)

        self.repos_to_fork = repos_to_fork

        # Log summary
        if repos_to_fork:
            logger.info(f"Found {len(repos_to_fork)} GitHub repos needing forks:")
            for repo in repos_to_fork:
                logger.info(f"  - {repo.name}: {repo.upstream}")

        if gitlab_repos:
            logger.warning(f"Skipping {len(gitlab_repos)} GitLab repos (manual forking required):")
            for repo in gitlab_repos:
                logger.warning(f"  - {repo.name}: {repo.upstream}")

        if not repos_to_fork:
            return OperationResult(
                operation="detect_unforkable_repos",
                status=OperationStatus.SKIPPED,
                message="No repos need forking",
            )

        return OperationResult(
            operation="detect_unforkable_repos",
            status=OperationStatus.SUCCESS,
            message=f"Found {len(repos_to_fork)} repos needing forks",
            details={"repos": [r.name for r in repos_to_fork]},
        )

    def fork_repos(self) -> OperationResult:
        """
        Create forks for detected repos using gh repo fork.

        Returns:
            OperationResult with fork details
        """
        if not self.repos_to_fork:
            return OperationResult(
                operation="fork_repos",
                status=OperationStatus.SKIPPED,
                message="No repos to fork",
            )

        logger.info(f"Forking {len(self.repos_to_fork)} repos...")

        failed = []
        for repo in self.repos_to_fork:
            # Extract owner/repo from upstream URL
            parsed = urlparse(repo.upstream)
            path = parsed.path.rstrip(".git").lstrip("/")

            logger.info(f"Forking {path}...")

            if self.dry_run:
                fork_url = f"https://github.com/{self.bot_username}/{repo.name}.git"
                self.forked_repos[repo.name] = fork_url
                logger.info(f"[DRY RUN] Would fork {path} to {fork_url}")
                continue

            try:
                # Use gh repo fork to create the fork
                # --clone=false prevents automatic cloning
                result = subprocess.run(
                    ["gh", "repo", "fork", path, "--clone=false"],
                    capture_output=True,
                    text=True,
                    timeout=30,
                )

                if result.returncode != 0:
                    # Check if already forked (not an error)
                    if "already exists" in result.stderr.lower() or "already forked" in result.stderr.lower():
                        logger.info(f"{path} already forked")
                        fork_url = f"https://github.com/{self.bot_username}/{repo.name}.git"
                        self.forked_repos[repo.name] = fork_url
                    else:
                        error_msg = f"Failed to fork {path}: {result.stderr}"
                        logger.error(error_msg)
                        failed.append(repo.name)
                        continue
                else:
                    fork_url = f"https://github.com/{self.bot_username}/{repo.name}.git"
                    self.forked_repos[repo.name] = fork_url
                    logger.info(f"Forked {path} to {fork_url}")

            except Exception as e:
                error_msg = f"Exception forking {path}: {e}"
                logger.error(error_msg)
                failed.append(repo.name)

        if failed:
            error_msg = f"Failed to fork {len(failed)} repos: {', '.join(failed)}"
            logger.error(error_msg)
            return OperationResult(
                operation="fork_repos",
                status=OperationStatus.FAILED,
                message=error_msg,
                details={"failed": failed},
            )

        return OperationResult(
            operation="fork_repos",
            status=OperationStatus.SUCCESS,
            message=f"Forked {len(self.forked_repos)} repos",
            details={"forked": list(self.forked_repos.keys())},
        )

    def update_and_commit(self) -> OperationResult:
        """
        Update project-repos.json with fork URLs and commit changes.

        Returns:
            OperationResult with commit details
        """
        if not self.forked_repos:
            return OperationResult(
                operation="update_and_commit",
                status=OperationStatus.SKIPPED,
                message="No forks to update",
            )

        logger.info(f"Updating {self.project_repos_path}...")

        if self.dry_run:
            logger.info("[DRY RUN] Would update project-repos.json with:")
            for name, fork_url in self.forked_repos.items():
                logger.info(f"  {name}: url = {fork_url}")
            logger.info("[DRY RUN] Would commit changes")
            return OperationResult(
                operation="update_and_commit",
                status=OperationStatus.SUCCESS,
                message="Updated and committed (dry run)",
                details={"updates": self.forked_repos},
            )

        try:
            # Load current config
            with open(self.project_repos_path) as f:
                repos_config = json.load(f)

            # Update fork URLs
            for name, fork_url in self.forked_repos.items():
                if name in repos_config:
                    repos_config[name]["url"] = fork_url
                    logger.info(f"Updated {name}: url = {fork_url}")

            # Write updated config
            with open(self.project_repos_path, "w") as f:
                json.dump(repos_config, f, indent=2)
                f.write("\n")  # Add trailing newline

            logger.info(f"Updated {len(self.forked_repos)} repo entries")

            # Work in config directory
            config_work_dir = self.config_dir if self.config_dir == REMOTE_CONFIG_DIR else self.config_dir
            os.chdir(config_work_dir)

            # Ensure we're on default branch and up to date
            subprocess.run(
                ["git", "fetch", "origin"],
                check=True,
                capture_output=True,
                timeout=30,
            )

            # Get default branch name
            default_branch_result = subprocess.run(
                ["git", "symbolic-ref", "refs/remotes/origin/HEAD"],
                capture_output=True,
                text=True,
                timeout=10,
            )
            default_branch = (
                default_branch_result.stdout.strip().split("/")[-1]
                if default_branch_result.returncode == 0
                else "master"
            )

            subprocess.run(
                ["git", "checkout", default_branch],
                check=True,
                capture_output=True,
            )

            subprocess.run(
                ["git", "pull", "--ff-only"],
                check=True,
                capture_output=True,
            )

            # Create branch
            instance_suffix = f"-{self.instance_id}" if self.instance_id else ""
            branch_name = f"bot/auto-fork{instance_suffix}"

            subprocess.run(
                ["git", "checkout", "-b", branch_name],
                check=True,
                capture_output=True,
            )

            # Stage changes
            rel_path = self.project_repos_path.relative_to(config_work_dir)
            subprocess.run(
                ["git", "add", str(rel_path)],
                check=True,
                capture_output=True,
            )

            # Commit
            instance_label = self.instance_id or "bot"
            commit_msg = f"chore: auto-fork repos for {instance_label}\n\nForked {len(self.forked_repos)} repos:\n"
            for name in self.forked_repos.keys():
                commit_msg += f"- {name}\n"

            subprocess.run(
                ["git", "commit", "-m", commit_msg],
                check=True,
                capture_output=True,
            )

            logger.info(f"Committed changes to branch {branch_name}")
            logger.info(f"Working directory: {config_work_dir}")
            logger.info("Next: use push-and-pr skill to create PR")

            return OperationResult(
                operation="update_and_commit",
                status=OperationStatus.SUCCESS,
                message=f"Updated {len(self.forked_repos)} entries and committed to {branch_name}",
                details={
                    "updates": self.forked_repos,
                    "branch": branch_name,
                    "working_dir": str(config_work_dir),
                },
            )

        except Exception as e:
            error_msg = f"Exception during update_and_commit: {e}"
            logger.error(error_msg)
            return OperationResult(
                operation="update_and_commit",
                status=OperationStatus.FAILED,
                message=error_msg,
            )

    def execute_workflow(self) -> List[OperationResult]:
        """
        Execute the auto-fork workflow (without PR creation).

        Returns:
            List of operation results
        """
        results = []

        # 1. Detect repos needing forks
        result = self.detect_unforkable_repos()
        results.append(result)
        if result.status == OperationStatus.FAILED:
            return results
        if result.status == OperationStatus.SKIPPED:
            logger.info("No repos need forking. Workflow complete.")
            return results

        # 2. Fork repos
        result = self.fork_repos()
        results.append(result)
        if result.status == OperationStatus.FAILED:
            return results
        if result.status == OperationStatus.SKIPPED:
            return results

        # 3. Update project-repos.json and commit
        result = self.update_and_commit()
        results.append(result)

        return results


def main():
    """Main entry point."""
    parser = argparse.ArgumentParser(description="Auto-fork repos and update config")
    parser.add_argument("--dry-run", action="store_true", help="Log actions without executing")
    args = parser.parse_args()

    logger.info("Starting auto-fork workflow...")
    if args.dry_run:
        logger.info("DRY RUN MODE - no actual changes will be made")

    ops = AutoForkOperations(dry_run=args.dry_run)
    results = ops.execute_workflow()

    # Print summary
    print("\n=== Auto-Fork Workflow Results ===")
    for result in results:
        status_text = result.status.value.upper()
        print(f"[{status_text}] {result.operation}: {result.message}")
        if result.details:
            for key, value in result.details.items():
                print(f"  {key}: {value}")

    # Exit code
    if any(r.status == OperationStatus.FAILED for r in results):
        sys.exit(1)
    else:
        if not args.dry_run and results and results[-1].status == OperationStatus.SUCCESS:
            print("\nChanges committed successfully!")
            print("Next step: cd to the working directory and use push-and-pr skill to create PR")
        sys.exit(0)


if __name__ == "__main__":
    main()
