#!/usr/bin/env python3
"""
Collect all Jira tickets from a saved filter, extract PR/MR links from
comments and GitHub PR search, and generate a CSV report.

Zero dependencies — uses only Python stdlib + gh CLI for auth.

Prerequisites:
  gh   — GitHub CLI, authenticated (gh auth status)

Environment variables (required):
  JIRA_TOKEN     — Jira personal access token (PAT) or API token

Environment variables (optional):
  JIRA_URL       — Jira base URL          (default: https://redhat.atlassian.net)
  JIRA_EMAIL     — Jira email for Basic auth; if set, uses Basic auth
                   (email:token). If unset, uses Bearer token auth.
  JIRA_FILTER_ID — Jira saved filter ID   (default: 107017)
  GH_BOT_USER       — GitHub bot username          (default: platex-rehor-bot)
  BOT_LABEL_PREFIX  — Label prefix for bot labels  (default: hcc-ai-)
  OUTPUT_FILE       — Output CSV path              (default: tickets-with-prs.csv)

Usage:
  export JIRA_TOKEN="..."
  python3 collect-impact-data.py
"""

import csv
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from base64 import b64encode
from datetime import date, datetime

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

JIRA_URL = os.environ.get("JIRA_URL", "https://redhat.atlassian.net").rstrip("/")
JIRA_TOKEN = os.environ.get("JIRA_TOKEN", "")
JIRA_EMAIL = os.environ.get("JIRA_EMAIL", "")
JIRA_FILTER_ID = os.environ.get("JIRA_FILTER_ID", "107017")

GH_BOT_USER = os.environ.get("GH_BOT_USER", "platex-rehor-bot")
BOT_LABEL_PREFIX = os.environ.get("BOT_LABEL_PREFIX", "hcc-ai-")

OUTPUT_FILE = os.environ.get("OUTPUT_FILE", "tickets-with-prs.csv")

JIRA_PAGE_SIZE = 50
GH_PAGE_SIZE = 100

# ---------------------------------------------------------------------------
# CLI helpers
# ---------------------------------------------------------------------------


def run_cli(cmd, retries=3):
    """Run a CLI command, return parsed JSON or None on failure."""
    for attempt in range(retries):
        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=60,
            )
            if result.returncode == 0:
                return json.loads(result.stdout) if result.stdout.strip() else None
            stderr = result.stderr.lower()
            if "rate limit" in stderr or "secondary" in stderr or "502" in stderr:
                wait = 2 ** (attempt + 1)
                print(f"  Rate limited, retrying in {wait}s...", file=sys.stderr)
                time.sleep(wait)
                continue
            print(f"  CLI error: {result.stderr.strip()}", file=sys.stderr)
            return None
        except subprocess.TimeoutExpired:
            print(f"  Timeout on attempt {attempt + 1}", file=sys.stderr)
        except json.JSONDecodeError:
            return None
    return None


def check_cli(name, check_cmd):
    """Verify a CLI tool is installed and authenticated."""
    try:
        result = subprocess.run(
            check_cmd,
            capture_output=True,
            text=True,
            timeout=10,
        )
        return result.returncode == 0
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False


# ---------------------------------------------------------------------------
# Jira HTTP helpers
# ---------------------------------------------------------------------------


def jira_headers():
    headers = {"Accept": "application/json"}
    if JIRA_EMAIL:
        cred = b64encode(f"{JIRA_EMAIL}:{JIRA_TOKEN}".encode()).decode()
        headers["Authorization"] = f"Basic {cred}"
    else:
        headers["Authorization"] = f"Bearer {JIRA_TOKEN}"
    return headers


class NoRedirect(urllib.request.HTTPRedirectHandler):
    """Re-attach Authorization header on cross-host redirects."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        new_req = super().redirect_request(req, fp, code, msg, headers, newurl)
        if new_req is not None and "Authorization" not in new_req.headers:
            auth = req.get_header("Authorization")
            if auth:
                new_req.add_unredirected_header("Authorization", auth)
        return new_req


_jira_opener = urllib.request.build_opener(NoRedirect)


def jira_get(url, retries=3, backoff=2):
    """GET from Jira with retries."""
    req = urllib.request.Request(url, headers=jira_headers())
    for attempt in range(retries):
        try:
            with _jira_opener.open(req, timeout=30) as resp:
                return json.loads(resp.read().decode())
        except urllib.error.HTTPError as e:
            if e.code == 429 or e.code >= 500:
                wait = backoff ** (attempt + 1)
                print(f"  HTTP {e.code}, retrying in {wait}s...", file=sys.stderr)
                time.sleep(wait)
                continue
            body = e.read().decode("utf-8", errors="replace")[:500]
            print(f"  HTTP {e.code} from {e.url}", file=sys.stderr)
            print(f"  Response: {body}", file=sys.stderr)
            raise
        except (urllib.error.URLError, TimeoutError) as e:
            wait = backoff ** (attempt + 1)
            print(f"  Network error ({e}), retrying in {wait}s...", file=sys.stderr)
            time.sleep(wait)
    print(f"  FAILED after {retries} retries: {url}", file=sys.stderr)
    return None


# ---------------------------------------------------------------------------
# ADF (Atlassian Document Format) → plain text
# ---------------------------------------------------------------------------


def flatten_adf(node):
    """Recursively extract plain text and link URLs from an ADF document."""
    if isinstance(node, str):
        return node
    if not isinstance(node, dict):
        return ""

    parts = []

    for mark in node.get("marks", []):
        if mark.get("type") == "link":
            href = mark.get("attrs", {}).get("href", "")
            if href:
                parts.append(f" {href} ")

    if node.get("type") == "inlineCard":
        card_url = node.get("attrs", {}).get("url", "")
        if card_url:
            parts.append(f" {card_url} ")

    if node.get("type") == "text":
        parts.append(node.get("text", ""))

    for child in node.get("content", []):
        parts.append(flatten_adf(child))

    return "".join(parts)


# ---------------------------------------------------------------------------
# Link extraction regexes
# ---------------------------------------------------------------------------

GH_PR_RE = re.compile(r"https://github\.com/[^\s\)\]\|]+/pull/\d+")
GL_MR_RE = re.compile(r"https://gitlab\.cee\.redhat\.com/[^\s\)\]\|]+/merge_requests/\d+")
TICKET_KEY_RE = re.compile(r"RHCLOUD-\d+")


def extract_links_from_comments(comments):
    """Extract GitHub PR and GitLab MR URLs from a list of Jira comments."""
    gh_prs = []
    gl_mrs = []
    for comment in comments:
        body = comment.get("body", "")
        if isinstance(body, dict):
            body = flatten_adf(body)
        for m in GH_PR_RE.findall(body):
            url_clean = m.rstrip(".,;:!?")
            if url_clean not in gh_prs:
                gh_prs.append(url_clean)
        for m in GL_MR_RE.findall(body):
            url_clean = m.rstrip(".,;:!?")
            if url_clean not in gl_mrs:
                gl_mrs.append(url_clean)
    return gh_prs, gl_mrs


# ---------------------------------------------------------------------------
# Jira: fetch tickets + comments in one pass
# ---------------------------------------------------------------------------


def fetch_all_tickets_with_comments():
    """Paginate through Jira search, returning tickets and comment links.

    By including 'comment' in the search fields, we get comments inline
    with each issue — no separate API call per ticket needed.
    The search returns up to ~20 comments per issue, which covers most
    bot tickets. For tickets with more, we do a single follow-up call.
    """
    tickets = []
    comment_links = {}
    has_links = 0
    overflow_keys = []

    jql = urllib.parse.quote(f"filter={JIRA_FILTER_ID}", safe="=")
    fields = "summary,status,issuetype,labels,comment"
    next_token = None

    while True:
        url = f"{JIRA_URL}/rest/api/3/search/jql?jql={jql}&fields={fields}&maxResults={JIRA_PAGE_SIZE}"
        if next_token:
            url += f"&nextPageToken={urllib.parse.quote(next_token)}"

        data = jira_get(url)
        if not data:
            print("ERROR: failed to fetch tickets from Jira", file=sys.stderr)
            sys.exit(1)

        for issue in data.get("issues", []):
            f = issue["fields"]
            tickets.append(
                {
                    "key": issue["key"],
                    "summary": f.get("summary", ""),
                    "status": f.get("status", {}).get("name", ""),
                    "type": f.get("issuetype", {}).get("name", ""),
                    "labels": f.get("labels", []),
                }
            )

            comment_field = f.get("comment", {})
            comments = comment_field.get("comments", [])
            total_comments = comment_field.get("total", len(comments))

            gh, gl = extract_links_from_comments(comments)
            if gh or gl:
                comment_links[issue["key"]] = {"github_prs": gh, "gitlab_mrs": gl}
                has_links += 1

            if total_comments > len(comments):
                overflow_keys.append(issue["key"])

        total = data.get("total", len(tickets))
        print(
            f"  Fetched {len(tickets)}/{total} tickets ({has_links} with PR/MR links)",
            file=sys.stderr,
        )

        next_token = data.get("nextPageToken")
        if not next_token:
            break

    # Fetch full comments for tickets that had more than the inline limit
    if overflow_keys:
        print(
            f"  Fetching full comments for {len(overflow_keys)} tickets with >20 comments...",
            file=sys.stderr,
        )
        for key in overflow_keys:
            url = f"{JIRA_URL}/rest/api/3/issue/{key}/comment?maxResults=100"
            data = jira_get(url)
            if not data:
                continue
            gh, gl = extract_links_from_comments(data.get("comments", []))
            if gh or gl:
                existing = comment_links.get(key, {"github_prs": [], "gitlab_mrs": []})
                for u in gh:
                    if u not in existing["github_prs"]:
                        existing["github_prs"].append(u)
                for u in gl:
                    if u not in existing["gitlab_mrs"]:
                        existing["gitlab_mrs"].append(u)
                comment_links[key] = existing
            time.sleep(0.5)

    return tickets, comment_links


# ---------------------------------------------------------------------------
# GitHub: search PRs by author using gh CLI
# ---------------------------------------------------------------------------


def search_github_prs():
    """Search all PRs by the bot user using gh api."""
    all_prs = []
    page = 1

    while True:
        q = f"author:{GH_BOT_USER} type:pr"
        cmd = [
            "gh",
            "api",
            f"/search/issues?q={urllib.parse.quote(q)}&per_page={GH_PAGE_SIZE}&page={page}",
        ]
        data = run_cli(cmd)
        if not data:
            break

        items = data.get("items", [])
        if not items:
            break

        for item in items:
            repo_url = item.get("repository_url", "")
            repo = "/".join(repo_url.split("/")[-2:]) if repo_url else ""
            pr_meta = item.get("pull_request", {}) or {}
            all_prs.append(
                {
                    "url": item.get("html_url", ""),
                    "repo": repo,
                    "state": item.get("state", ""),
                    "title": item.get("title", ""),
                    "body": item.get("body", "") or "",
                    "created_at": item.get("created_at", ""),
                    "merged_at": pr_meta.get("merged_at"),
                }
            )

        total = data.get("total_count", 0)
        print(
            f"  GitHub search: page {page}, {len(all_prs)}/{total} PRs",
            file=sys.stderr,
        )

        if len(all_prs) >= total:
            break
        page += 1
        time.sleep(2)

    return all_prs


def match_prs_to_tickets(prs):
    """Match PRs to Jira tickets by scanning PR title + body for keys."""
    ticket_map = {}
    for pr in prs:
        text = f"{pr['title']} {pr['body']}"
        keys = set(TICKET_KEY_RE.findall(text))
        for key in keys:
            ticket_map.setdefault(key, []).append(
                {
                    "url": pr["url"],
                    "repo": pr["repo"],
                    "state": pr["state"],
                }
            )
    return ticket_map


# ---------------------------------------------------------------------------
# Helpers for label parsing
# ---------------------------------------------------------------------------


def get_repo_labels(labels):
    return [label[5:] for label in labels if label.startswith("repo:")]


def get_bot_label(labels):
    for label in labels:
        if label.startswith(BOT_LABEL_PREFIX):
            return label
    return ""


# ---------------------------------------------------------------------------
# CSV output
# ---------------------------------------------------------------------------


def write_csv(tickets, pr_map, comment_links, output_path):
    """Merge all data sources and write CSV."""
    with_prs = 0
    with_mrs = 0

    with open(output_path, "w", newline="") as f:
        writer = csv.writer(f)
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
            repos = get_repo_labels(ticket["labels"])
            bot = get_bot_label(ticket["labels"])

            gh_prs = []
            gl_mrs = []

            if key in pr_map:
                for pr in pr_map[key]:
                    if pr["url"] not in gh_prs:
                        gh_prs.append(pr["url"])

            if key in comment_links:
                cl = comment_links[key]
                for url in cl.get("github_prs", []):
                    if url not in gh_prs:
                        gh_prs.append(url)
                for url in cl.get("gitlab_mrs", []):
                    if url not in gl_mrs:
                        gl_mrs.append(url)

            if gh_prs:
                with_prs += 1
            if gl_mrs:
                with_mrs += 1

            jira_link = f"https://issues.redhat.com/browse/{key}"
            pr_search = f"https://github.com/search?q={key}+type%3Apr&type=pullrequests"

            writer.writerow(
                [
                    key,
                    ticket["summary"][:120],
                    ticket["status"],
                    ticket["type"],
                    bot,
                    " | ".join(repos),
                    " | ".join(gh_prs),
                    " | ".join(gl_mrs),
                    jira_link,
                    pr_search,
                ]
            )

    return with_prs, with_mrs


# ---------------------------------------------------------------------------
# Summary stats
# ---------------------------------------------------------------------------


def print_summary(tickets, pr_map, comment_links, with_prs, with_mrs):
    all_gh = set()
    all_gl = set()
    for key in [t["key"] for t in tickets]:
        if key in pr_map:
            for pr in pr_map[key]:
                all_gh.add(pr["url"])
        if key in comment_links:
            for u in comment_links[key].get("github_prs", []):
                all_gh.add(u)
            for u in comment_links[key].get("gitlab_mrs", []):
                all_gl.add(u)

    repos = set()
    for url in all_gh:
        m = re.match(r"https://github\.com/([^/]+/[^/]+)/pull/\d+", url)
        if m:
            repos.add(m.group(1))

    print("\n" + "=" * 60, file=sys.stderr)
    print("IMPACT DATA COLLECTION COMPLETE", file=sys.stderr)
    print("=" * 60, file=sys.stderr)
    print(f"  Jira tickets:           {len(tickets)}", file=sys.stderr)
    print(f"  Unique GitHub PRs:      {len(all_gh)}", file=sys.stderr)
    print(f"  Unique GitLab MRs:      {len(all_gl)}", file=sys.stderr)
    print(f"  Total PR/MRs:           {len(all_gh) + len(all_gl)}", file=sys.stderr)
    print(f"  GitHub repos:           {len(repos)}", file=sys.stderr)
    print(f"  Tickets with GH PRs:    {with_prs}", file=sys.stderr)
    print(f"  Tickets with GL MRs:    {with_mrs}", file=sys.stderr)
    print(f"  Output:                 {OUTPUT_FILE}", file=sys.stderr)
    print("=" * 60, file=sys.stderr)


# ---------------------------------------------------------------------------
# PR category classification
# ---------------------------------------------------------------------------

CVE_KEYWORDS = re.compile(r"CVE-\d{4}-\d+|security|vulnerabilit", re.IGNORECASE)


def classify_pr(title):
    """Classify a PR by its conventional-commit title prefix."""
    t = title.lower().strip()
    if t.startswith("docs(") or t.startswith("docs:"):
        return "Documentation"
    if t.startswith("refactor(") or t.startswith("refactor:"):
        return "Refactoring"
    if t.startswith("ci(") or t.startswith("ci:") or t.startswith("build(") or t.startswith("build:"):
        return "CI/CD improvements"
    if t.startswith("chore(deps") or t.startswith("chore(renovate"):
        return "Dependency updates"
    if t.startswith("fix(deps"):
        if CVE_KEYWORDS.search(title):
            return "CVE / Security fixes"
        return "Dependency updates"
    if t.startswith("fix(") or t.startswith("fix:"):
        if CVE_KEYWORDS.search(title):
            return "CVE / Security fixes"
        return "Bug fixes"
    if t.startswith("feat(") or t.startswith("feat:"):
        return "Features & enhancements"
    if CVE_KEYWORDS.search(title):
        return "CVE / Security fixes"
    return "Other"


CATEGORY_ORDER = [
    "Features & enhancements",
    "Bug fixes",
    "CVE / Security fixes",
    "Dependency updates",
    "CI/CD improvements",
    "Refactoring",
    "Documentation",
    "Other",
]

# ---------------------------------------------------------------------------
# Stats computation for report generation
# ---------------------------------------------------------------------------


def compute_stats(tickets, pr_map, comment_links, gh_prs, with_prs, with_mrs):
    """Compute all aggregate stats needed by the report template."""

    # --- Unique PR/MR URLs across all sources ---
    all_gh = set()
    all_gl = set()
    for t in tickets:
        key = t["key"]
        if key in pr_map:
            for pr in pr_map[key]:
                all_gh.add(pr["url"])
        if key in comment_links:
            for u in comment_links[key].get("github_prs", []):
                all_gh.add(u)
            for u in comment_links[key].get("gitlab_mrs", []):
                all_gl.add(u)

    # --- Repos and orgs from PR URLs ---
    repo_counts = {}
    org_counts = {}
    for url in all_gh:
        m = re.match(r"https://github\.com/([^/]+)/([^/]+)/pull/\d+", url)
        if m:
            org, repo_name = m.group(1), m.group(2)
            full = f"{org}/{repo_name}"
            repo_counts[full] = repo_counts.get(full, 0) + 1
            org_counts[org] = org_counts.get(org, 0) + 1

    top_repos = sorted(repo_counts.items(), key=lambda x: -x[1])[:15]
    orgs_sorted = sorted(org_counts.items(), key=lambda x: -x[1])

    org_notable = {}
    for full, count in sorted(repo_counts.items(), key=lambda x: -x[1]):
        org = full.split("/")[0]
        org_notable.setdefault(org, [])
        if len(org_notable[org]) < 5:
            org_notable[org].append({"repo": full, "count": count})

    # --- Bot-account PR stats ---
    bot_total = len(gh_prs)
    bot_merged = sum(1 for p in gh_prs if p.get("merged_at"))
    bot_open = sum(1 for p in gh_prs if p.get("state") == "open")
    bot_closed_not_merged = bot_total - bot_merged - bot_open

    # --- PR categories ---
    cat_counts = {}
    for pr in gh_prs:
        cat = classify_pr(pr.get("title", ""))
        cat_counts[cat] = cat_counts.get(cat, 0) + 1

    pr_categories = []
    for cat in CATEGORY_ORDER:
        count = cat_counts.get(cat, 0)
        if count > 0:
            pct = round(100 * count / bot_total) if bot_total else 0
            pr_categories.append({"category": cat, "count": count, "pct": pct})

    # --- Ticket types ---
    type_counts = {}
    for t in tickets:
        tp = t["type"]
        type_counts[tp] = type_counts.get(tp, 0) + 1
    ticket_types = sorted(type_counts.items(), key=lambda x: -x[1])

    # --- Bot labels ---
    bot_labels = sorted({lb for t in tickets for lb in t["labels"] if lb.startswith(BOT_LABEL_PREFIX)})

    # --- Timeline ---
    first_pr_date = None
    today = date.today()
    period_days = 0
    prs_per_day = 0.0
    # Try to extract created_at from gh_prs (search API returns it)
    pr_dates = []
    for pr in gh_prs:
        created = pr.get("created_at", "")
        if created:
            try:
                pr_dates.append(datetime.fromisoformat(created.replace("Z", "+00:00")).date())
            except (ValueError, TypeError):
                pass
    if pr_dates:
        first_pr_date = min(pr_dates).isoformat()
        period_days = (today - min(pr_dates)).days
        if period_days > 0:
            prs_per_day = round(bot_total / period_days, 1)

    personal_prs = len(all_gh) - bot_total

    return {
        "generated_date": datetime.now().strftime("%B %Y"),
        "generated_iso": datetime.now().isoformat()[:10],
        "total_tickets": len(tickets),
        "tickets_with_gh_prs": with_prs,
        "tickets_with_gl_mrs": with_mrs,
        "total_gh_prs": len(all_gh),
        "total_gl_mrs": len(all_gl),
        "total_prmrs": len(all_gh) + len(all_gl),
        "bot_prs_total": bot_total,
        "bot_prs_merged": bot_merged,
        "bot_prs_open": bot_open,
        "bot_prs_closed_not_merged": bot_closed_not_merged,
        "merge_rate": round(100 * bot_merged / bot_total, 1) if bot_total else 0,
        "personal_prs": personal_prs if personal_prs > 0 else 0,
        "unique_repos": len(repo_counts),
        "unique_orgs": len(org_counts),
        "prs_per_day": prs_per_day,
        "first_pr_date": first_pr_date or "unknown",
        "period_days": period_days,
        "ticket_types": [{"type": t, "count": c} for t, c in ticket_types],
        "pr_categories": pr_categories,
        "top_repos": [{"repo": full, "url": f"https://github.com/{full}", "count": c} for full, c in top_repos],
        "orgs": [
            {
                "org": org,
                "url": f"https://github.com/{org}",
                "count": c,
                "notable_repos": org_notable.get(org, []),
            }
            for org, c in orgs_sorted
        ],
        "bot_labels": bot_labels,
    }


def write_stats_json(stats, output_dir):
    """Write stats dict to JSON for report generation."""
    path = os.path.join(output_dir, "stats.json")
    with open(path, "w") as f:
        json.dump(stats, f, indent=2)
    print(f"  Stats written to {path}", file=sys.stderr)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main():
    if not JIRA_TOKEN:
        print("ERROR: JIRA_TOKEN environment variable is required", file=sys.stderr)
        sys.exit(1)

    if not check_cli("gh", ["gh", "auth", "status"]):
        print("ERROR: gh CLI is not installed or not authenticated", file=sys.stderr)
        print("  Run: gh auth login", file=sys.stderr)
        sys.exit(1)

    ts = datetime.now().strftime("%Y-%m-%d %H:%M")
    print(f"[{ts}] Starting impact data collection", file=sys.stderr)
    print(f"  Jira: {JIRA_URL} (filter {JIRA_FILTER_ID})", file=sys.stderr)
    print(f"  GitHub bot user: {GH_BOT_USER}", file=sys.stderr)
    print(file=sys.stderr)

    # Step 1: Fetch all tickets + comments from Jira in one pass
    print("Step 1/3: Fetching Jira tickets with comments...", file=sys.stderr)
    tickets, comment_links = fetch_all_tickets_with_comments()
    print(
        f"  -> {len(tickets)} tickets, {len(comment_links)} with PR/MR links in comments\n",
        file=sys.stderr,
    )

    # Step 2: Search GitHub PRs by bot author
    print("Step 2/3: Searching GitHub PRs (via gh api)...", file=sys.stderr)
    gh_prs = search_github_prs()
    pr_map = match_prs_to_tickets(gh_prs)
    print(
        f"  -> {len(gh_prs)} PRs found, {len(pr_map)} matched to tickets\n",
        file=sys.stderr,
    )

    # Step 3: Write CSV
    print(f"Step 3/3: Writing CSV to {OUTPUT_FILE}...", file=sys.stderr)
    with_prs, with_mrs = write_csv(tickets, pr_map, comment_links, OUTPUT_FILE)

    print_summary(tickets, pr_map, comment_links, with_prs, with_mrs)

    # Step 4: Compute and write stats JSON for report generation
    output_dir = os.path.dirname(os.path.abspath(OUTPUT_FILE))
    stats = compute_stats(tickets, pr_map, comment_links, gh_prs, with_prs, with_mrs)
    write_stats_json(stats, output_dir)


if __name__ == "__main__":
    main()
