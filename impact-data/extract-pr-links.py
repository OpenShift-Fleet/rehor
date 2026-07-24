#!/usr/bin/env python3
"""
Extract PR/MR links from Jira ticket comments.

Reads all tickets-page*.json files, fetches comments for each ticket
via Jira API, extracts GitHub PR and GitLab MR URLs, and writes a CSV.

Usage:
    python3 extract-pr-links.py

Output:
    impact-data/tickets-with-prs.csv
"""

import csv
import glob
import json
import os
import re

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))


def load_all_tickets():
    """Load all ticket JSON files and return flat list."""
    tickets = []
    for f in sorted(glob.glob(os.path.join(SCRIPT_DIR, "tickets-page*.json"))):
        with open(f) as fh:
            tickets.extend(json.load(fh))
    return tickets


def get_comments_via_jira(issue_key):
    """Fetch comments for a Jira issue using the Jira REST API via gh/curl won't work.
    Instead, we'll use the jira CLI or just parse from saved data."""
    # We can't use MCP tools from a script, so we use the Jira REST API
    # via the jira-python library or similar
    pass


def extract_links_from_text(text):
    """Extract GitHub PR and GitLab MR URLs from text."""
    links = []

    # GitHub PR URLs: https://github.com/org/repo/pull/NNN
    gh_prs = re.findall(r"https://github\.com/[^\s\)]+/pull/\d+", text)
    for url in gh_prs:
        links.append(("github_pr", url))

    # GitLab MR URLs: https://gitlab.cee.redhat.com/.../merge_requests/NNN
    gl_mrs = re.findall(r"https://gitlab\.cee\.redhat\.com/[^\s\)]+/merge_requests/\d+", text)
    for url in gl_mrs:
        links.append(("gitlab_mr", url))

    # GitLab branch URLs
    gl_branches = re.findall(r"https://gitlab\.cee\.redhat\.com/[^\s\)]+/-/tree/bot/RHCLOUD-\d+", text)
    for url in gl_branches:
        links.append(("gitlab_branch", url))

    return links


def get_repo_from_labels(labels):
    """Extract repo name from repo: labels."""
    repos = []
    for label in labels:
        if label.startswith("repo:"):
            repos.append(label[5:])
    return repos


def get_bot_label(labels):
    """Extract bot instance label."""
    for label in labels:
        if label.startswith("hcc-ai-"):
            return label
    return ""


def main():
    tickets = load_all_tickets()
    print(f"Loaded {len(tickets)} tickets from JSON files")

    # Load PR mapping from GitHub search (already matched by body text)
    pr_map_file = os.path.join(SCRIPT_DIR, "ticket-to-prs.json")
    pr_map = {}
    if os.path.exists(pr_map_file):
        with open(pr_map_file) as f:
            pr_map = json.load(f)
        print(f"Loaded PR mapping for {len(pr_map)} tickets")

    # Load comment-extracted links from all comments-links-page*.json files
    comment_links = {}
    for cf in sorted(glob.glob(os.path.join(SCRIPT_DIR, "comments-links-page*.json"))):
        with open(cf) as f:
            data = json.load(f)
            comment_links.update(data)
    print(
        f"Loaded comment links for {len(comment_links)} tickets from"
        f" {len(glob.glob(os.path.join(SCRIPT_DIR, 'comments-links-page*.json')))} files"
    )

    # Build CSV
    output_file = os.path.join(SCRIPT_DIR, "tickets-with-prs.csv")
    tickets_with_prs = 0
    tickets_with_mrs = 0
    with open(output_file, "w", newline="") as csvfile:
        writer = csv.writer(csvfile)
        writer.writerow(
            [
                "Ticket Key",
                "Summary",
                "Status",
                "Type",
                "Bot Instance",
                "Target Repo(s)",
                "GitHub PRs",
                "GitLab MRs",
                "Jira Link",
                "PR Search Link",
            ]
        )

        for ticket in tickets:
            key = ticket["key"]
            repos = get_repo_from_labels(ticket["labels"])
            bot_label = get_bot_label(ticket["labels"])

            gh_prs = []
            gl_mrs = []

            # From GitHub search matching (by PR body text)
            if key in pr_map:
                for pr in pr_map[key]:
                    if pr["url"] not in gh_prs:
                        gh_prs.append(pr["url"])

            # From Jira comment extraction
            if key in comment_links:
                cl = comment_links[key]
                for url in cl.get("github_prs", []):
                    if url not in gh_prs:
                        gh_prs.append(url)
                for url in cl.get("gitlab_mrs", []):
                    if url not in gl_mrs:
                        gl_mrs.append(url)

            if gh_prs:
                tickets_with_prs += 1
            if gl_mrs:
                tickets_with_mrs += 1

            jira_link = f"https://issues.redhat.com/browse/{key}"
            pr_search = f"https://github.com/search?q={key}+type%3Apr&type=pullrequests"

            writer.writerow(
                [
                    key,
                    ticket["summary"][:120],
                    ticket["status"],
                    ticket["type"],
                    bot_label,
                    " | ".join(repos),
                    " | ".join(gh_prs),
                    " | ".join(gl_mrs),
                    jira_link,
                    pr_search,
                ]
            )

    print(f"\nWrote {len(tickets)} rows to {output_file}")
    print(f"  {tickets_with_prs} tickets have GitHub PRs")
    print(f"  {tickets_with_mrs} tickets have GitLab MRs")


if __name__ == "__main__":
    main()
