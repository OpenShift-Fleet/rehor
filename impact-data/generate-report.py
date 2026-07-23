#!/usr/bin/env python3
"""
Generate rehor-impact-assessment.md from stats.json + template.

Zero dependencies — uses only Python stdlib.

Usage:
    python3 generate-report.py
    python3 generate-report.py --stats stats.json --template impact-assessment.md.template
        --output ../rehor-impact-assessment.md
"""

import argparse
import json
import os
import re
import sys
from datetime import date, datetime

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))


def render_pr_categories_table(categories):
    lines = ["| Category | Count | % |", "|----------|-------|---|"]
    for cat in categories:
        pct = f"{cat['pct']}%" if cat["pct"] >= 1 else "<1%"
        lines.append(f"| {cat['category']} | {cat['count']} | {pct} |")
    return "\n".join(lines)


def render_orgs_table(orgs):
    lines = [
        "| Organization | PRs | Notable Repos |",
        "|-------------|-----|---------------|",
    ]
    for org in orgs:
        notable = ", ".join(
            f"[{r['repo'].split('/')[-1]}]({r.get('url', 'https://github.com/' + r['repo'])}) ({r['count']})"
            if "url" not in r
            else f"[{r['repo'].split('/')[-1]}](https://github.com/{r['repo']}) ({r['count']})"
            for r in org.get("notable_repos", [])
        )
        lines.append(f"| [{org['org']}]({org['url']}) | {org['count']} | {notable} |")
    return "\n".join(lines)


def render_top_repos_table(repos):
    lines = ["| Repository | PRs |", "|-----------|-----|"]
    for r in repos:
        name = r["repo"].split("/")[-1]
        lines.append(f"| [{name}]({r['url']}) | {r['count']} |")
    return "\n".join(lines)


def render_ticket_types_table(types):
    lines = ["| Type | Count |", "|------|-------|"]
    jql_base = "https://redhat.atlassian.net/issues/?jql=filter%3D107017%20AND%20issuetype%3D"
    type_labels = {
        "Vulnerability": "Vulnerability",
        "Task": "Tasks",
        "Story": "Stories (features)",
        "Bug": "Bugs",
        "Sub-task": "Sub-tasks",
        "Epic": "Epics",
    }
    for t in types:
        label = type_labels.get(t["type"], t["type"])
        jql_type = t["type"].replace(" ", "%20")
        lines.append(f"| [{label}]({jql_base}{jql_type}) | {t['count']} |")
    return "\n".join(lines)


LABEL_DESCRIPTIONS = {
    "hcc-ai-bot": "general HCC bot work",
    "hcc-ai-kessel": "Project Kessel",
    "hcc-ai-ui": "HCC UI / Platform Experience",
    "hcc-ai-platform-accessmanagement": "Access Management / RBAC",
    "hcc-ai-framework": "Console Platform Framework",
    "hcc-ai-integrations": "Consoledot Integrations",
}


def render_bot_labels_list(labels):
    lines = []
    for label in labels:
        jql = f"https://redhat.atlassian.net/issues/?jql=labels%3D{label}"
        desc = LABEL_DESCRIPTIONS.get(label, "")
        suffix = f" — {desc}" if desc else ""
        lines.append(f"- [`{label}`]({jql}){suffix}")
    return "\n".join(lines)


def format_date_display(iso_date):
    """Convert 2026-04-08 → April 8, 2026."""
    try:
        d = datetime.strptime(iso_date, "%Y-%m-%d")
        return d.strftime("%B %-d, %Y")
    except (ValueError, TypeError):
        return iso_date


def format_month_year(iso_date):
    """Convert 2026-04-08 → April 2026."""
    try:
        d = datetime.strptime(iso_date, "%Y-%m-%d")
        return d.strftime("%B %Y")
    except (ValueError, TypeError):
        return iso_date


def build_vars(stats):
    """Build the flat variable dict for template substitution."""
    v = dict(stats)

    # Pre-render dynamic table/list sections
    v["TABLE_PR_CATEGORIES"] = render_pr_categories_table(stats.get("pr_categories", []))
    v["TABLE_ORGS"] = render_orgs_table(stats.get("orgs", []))
    v["TABLE_TOP_REPOS"] = render_top_repos_table(stats.get("top_repos", []))
    v["TABLE_TICKET_TYPES"] = render_ticket_types_table(stats.get("ticket_types", []))
    v["LIST_BOT_LABELS"] = render_bot_labels_list(stats.get("bot_labels", []))

    # Formatted dates
    first = stats.get("first_pr_date", "")
    v["first_pr_date_formatted"] = format_date_display(first)
    v["first_pr_date_month_year"] = format_month_year(first)
    v["today_formatted"] = date.today().strftime("%B %-d, %Y")

    # Individual ticket type counts for the impact summary table (with Jira links)
    jql_base = "https://redhat.atlassian.net/issues/?jql=filter%3D107017%20AND%20issuetype%3D"
    for t in stats.get("ticket_types", []):
        jql_type = t["type"].replace(" ", "%20")
        v[f"ticket_type_{t['type']}"] = f"[{t['count']}]({jql_base}{jql_type})"

    return v


def render_template(template_text, variables):
    """Replace {{var}} placeholders with values from the variables dict."""

    def replacer(match):
        key = match.group(1)
        val = variables.get(key)
        if val is None:
            print(f"  WARNING: unknown variable {{{{{key}}}}}", file=sys.stderr)
            return match.group(0)
        return str(val)

    return re.sub(r"\{\{(\w+)\}\}", replacer, template_text)


def main():
    parser = argparse.ArgumentParser(description="Generate impact assessment MD from stats + template")
    parser.add_argument(
        "--stats",
        default=os.path.join(SCRIPT_DIR, "stats.json"),
        help="Path to stats.json (default: impact-data/stats.json)",
    )
    parser.add_argument(
        "--template",
        default=os.path.join(SCRIPT_DIR, "impact-assessment.md.template"),
        help="Path to template (default: impact-data/impact-assessment.md.template)",
    )
    parser.add_argument(
        "--output",
        default=os.path.join(SCRIPT_DIR, "..", "rehor-impact-assessment-generated.md"),
        help="Output MD path (default: rehor-impact-assessment-generated.md)",
    )
    args = parser.parse_args()

    if not os.path.exists(args.stats):
        print(f"ERROR: stats file not found: {args.stats}", file=sys.stderr)
        print("  Run collect-impact-data.py first to generate stats.json", file=sys.stderr)
        sys.exit(1)

    if not os.path.exists(args.template):
        print(f"ERROR: template not found: {args.template}", file=sys.stderr)
        sys.exit(1)

    with open(args.stats) as f:
        stats = json.load(f)

    with open(args.template) as f:
        template_text = f.read()

    variables = build_vars(stats)
    output = render_template(template_text, variables)

    with open(args.output, "w") as f:
        f.write(output)

    print(f"Generated: {args.output}", file=sys.stderr)
    print(
        f"  {stats.get('total_tickets', '?')} tickets, "
        f"{stats.get('total_prmrs', '?')} PR/MRs, "
        f"{stats.get('unique_repos', '?')} repos",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
