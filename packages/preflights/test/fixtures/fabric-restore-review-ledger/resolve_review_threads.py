#!/usr/bin/env python3
"""Resolve bot finding threads whose addressed state is already validated."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
from pathlib import Path


SHA_RE = re.compile(r"[0-9a-f]{40}")
FINDING_ID_RE = re.compile(r"F[1-9]\d*")
THREADS_QUERY = """
query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        nodes {
          id
          isResolved
          comments(first: 100) {
            nodes { body author { login } }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}
"""
RESOLVE_MUTATION = """
mutation($threadId: ID!) {
  resolveReviewThread(input: {threadId: $threadId}) {
    thread { id isResolved }
  }
}
"""


def run_json(command: list[str], description: str) -> dict:
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or f"{description} failed")
    try:
        value = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"{description} returned invalid JSON") from exc
    if not isinstance(value, dict):
        raise RuntimeError(f"{description} returned an invalid response")
    if value.get("errors"):
        raise RuntimeError(f"{description}: {value['errors'][0].get('message', 'GraphQL error')}")
    return value


def gh_graphql(query: str, variables: dict) -> dict:
    command = ["gh", "api", "graphql", "-f", f"query={query}"]
    for name, value in variables.items():
        command.extend(["-F", f"{name}={value}"])
    response = run_json(command, "GitHub GraphQL request")
    data = response.get("data")
    if not isinstance(data, dict):
        raise RuntimeError("GitHub GraphQL response has no data")
    return data


def current_head(repo: str, number: int) -> str:
    result = subprocess.run(
        ["gh", "api", f"repos/{repo}/pulls/{number}", "--jq", ".head.sha"],
        capture_output=True, text=True, check=False,
    )
    if result.returncode or not SHA_RE.fullmatch(result.stdout.strip()):
        raise RuntimeError(result.stderr.strip() or "Could not read the current PR head")
    return result.stdout.strip()


def bot_login() -> str:
    configured = os.environ.get("GH_USER_NAME", "").strip()
    if configured:
        return configured
    result = subprocess.run(
        ["gh", "api", "user", "--jq", ".login"],
        capture_output=True, text=True, check=False,
    )
    if result.returncode or not result.stdout.strip():
        raise RuntimeError("Could not identify the GitHub bot account")
    return result.stdout.strip()


def addressed_ids(ledger_path: Path) -> list[str]:
    ledger = json.loads(ledger_path.read_text())
    if not isinstance(ledger, list) or any(not isinstance(item, dict) for item in ledger):
        raise ValueError("Ledger must be an array of findings")
    result = []
    for item in ledger:
        ident, status = item.get("id"), item.get("status")
        if not isinstance(ident, str) or not FINDING_ID_RE.fullmatch(ident):
            raise ValueError("Ledger contains an invalid finding ID")
        if status not in {"open", "addressed"}:
            raise ValueError(f"Ledger contains an invalid status for {ident}")
        if status == "addressed":
            result.append(ident)
    return result


def review_threads(owner: str, name: str, number: int) -> list[dict]:
    threads = []
    after = None
    while True:
        variables = {"owner": owner, "name": name, "number": number}
        if after is not None:
            variables["after"] = after
        data = gh_graphql(THREADS_QUERY, variables)
        try:
            connection = data["repository"]["pullRequest"]["reviewThreads"]
        except (KeyError, TypeError) as exc:
            raise RuntimeError("GitHub returned no PR review-thread data") from exc
        nodes = connection.get("nodes")
        page_info = connection.get("pageInfo")
        if (not isinstance(nodes, list) or not isinstance(page_info, dict)
                or not isinstance(page_info.get("hasNextPage"), bool)):
            raise RuntimeError("GitHub returned invalid review-thread data")
        threads.extend(node for node in nodes if isinstance(node, dict))
        if not page_info["hasNextPage"]:
            return threads
        after = page_info.get("endCursor")
        if not isinstance(after, str) or not after:
            raise RuntimeError("GitHub review-thread pagination is missing its cursor")


def matching_threads(threads: list[dict], ident: str, login: str) -> list[dict]:
    marker = f"<!-- dev-review-bot:fabric-access-finding:{ident} -->"
    legacy_marker = f"<!-- fabric-access-finding:{ident} -->"
    matches = []
    for thread in threads:
        connection = thread.get("comments") or {}
        comments = connection.get("nodes") if isinstance(connection, dict) else None
        if not isinstance(comments, list):
            continue
        found = any(
            isinstance(comment, dict)
            and isinstance(comment.get("body"), str)
            and (marker in comment["body"] or legacy_marker in comment["body"])
            and isinstance(comment.get("author"), dict)
            and isinstance(comment["author"].get("login"), str)
            and comment["author"]["login"].casefold() == login.casefold()
            for comment in comments
        )
        if found and isinstance(thread.get("id"), str):
            matches.append(thread)
    return matches


def resolve(repo: str, number: int, head: str, ledger_path: Path) -> dict:
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo) or number < 1:
        raise ValueError("Repository or PR number is invalid")
    if not SHA_RE.fullmatch(head):
        raise ValueError("Expected head SHA is invalid")
    ids = addressed_ids(ledger_path)
    if not ids:
        return {"resolved": [], "already_resolved": []}
    if current_head(repo, number) != head:
        raise RuntimeError("PR head changed before finding threads could be resolved")

    login = bot_login()
    owner, name = repo.split("/", 1)
    threads = review_threads(owner, name, number)
    resolved, already_resolved = [], []
    for ident in ids:
        matches = matching_threads(threads, ident, login)
        if not matches:
            raise RuntimeError(f"No bot-authored inline thread found for addressed finding {ident}")
        for thread in matches:
            if thread.get("isResolved") is True:
                already_resolved.append(ident)
                continue
            if current_head(repo, number) != head:
                raise RuntimeError("PR head changed while finding threads were being resolved")
            data = gh_graphql(RESOLVE_MUTATION, {"threadId": thread["id"]})
            result = (data.get("resolveReviewThread") or {}).get("thread")
            if not isinstance(result, dict) or result.get("isResolved") is not True:
                raise RuntimeError(f"GitHub did not confirm resolving finding {ident}")
            resolved.append(ident)
    return {"resolved": sorted(set(resolved)), "already_resolved": sorted(set(already_resolved))}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True, help="GitHub owner/repository")
    parser.add_argument("--pr", required=True, type=int)
    parser.add_argument("--head-sha", required=True)
    parser.add_argument("--ledger", required=True, type=Path)
    args = parser.parse_args()
    try:
        print(json.dumps(resolve(args.repo, args.pr, args.head_sha, args.ledger)))
    except (OSError, RuntimeError, ValueError, json.JSONDecodeError) as exc:
        parser.exit(1, f"Review thread resolution failed: {exc}\n")


if __name__ == "__main__":
    main()
