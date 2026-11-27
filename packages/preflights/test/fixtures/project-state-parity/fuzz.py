#!/usr/bin/env python3
"""Randomized cross-check of the TypeScript mcp-atlassian ports (optional).

Complements generate.py: instead of a fixed corpus, this produces randomized
REST issues (ADF trees, custom-team shapes, issue links, priorities, labels)
and runs them through the same real mcp-atlassian 0.23.1 models and Fabric
project_coordinator.py. The emitted cases use the parity-goldens.json schema,
so the TypeScript side can be compared with the same assertions (snapshot,
digest, and per-issue MCP projection equality) — see the usage note below.

Not part of CI: it needs the pinned Python environment described in
generate.py. Run it when the mcp-atlassian pin changes or when the ports in
src/preflights/fabric-project-state/mcp.ts are touched:

  python3 fuzz.py --fabric /path/to/project_coordinator.py --out /tmp/fuzz.json
  node --input-type=module -e "…compare /tmp/fuzz.json like the parity test…"

Requires the same environment as generate.py (Python >= 3.10,
mcp-atlassian==0.23.1, the Fabric project_coordinator.py checkout).
"""

from __future__ import annotations

import argparse
import json
import random

from generate import TEAM_FIELD_ID, IMPLEMENTATION_LABEL, load_project_coordinator, mcp_issues

WORDS = ["café", "🧶 works", "plain", "line\nbreak", "quote's", "a b c", "", "x" * 30, "tab\there"]
TIMESTAMPS = [1732712400000, 0, 253402300799999, 253402300800000, -1, "1732712400000", "abc", 1]


def rand_text(randomizer: random.Random) -> str:
    return randomizer.choice(WORDS)


def rand_adf(randomizer: random.Random, depth: int = 0) -> dict:
    if depth > 3:
        return {"type": "text", "text": rand_text(randomizer)}
    kind = randomizer.choice(
        [
            "doc",
            "paragraph",
            "text",
            "codeBlock",
            "mention",
            "emoji",
            "date",
            "status",
            "inlineCard",
            "hardBreak",
            "heading",
            "bulletList",
            "listItem",
            "media",
        ]
    )
    if kind == "text":
        return {"type": "text", "text": rand_text(randomizer)}
    if kind == "hardBreak":
        return {"type": "hardBreak"}
    if kind == "mention":
        return {
            "type": "mention",
            "attrs": randomizer.choice(
                [{"id": "acc:1"}, {"id": "acc:1", "text": "@Martin"}, {"text": "@NoId"}, {}]
            ),
        }
    if kind == "emoji":
        return {
            "type": "emoji",
            "attrs": randomizer.choice([{"shortName": ":coffee:"}, {"text": "☕"}, {}]),
        }
    if kind == "date":
        return {"type": "date", "attrs": randomizer.choice([{"timestamp": randomizer.choice(TIMESTAMPS)}, {}])}
    if kind == "status":
        return {"type": "status", "attrs": randomizer.choice([{"text": "LOVE"}, {}, {"text": ""}])}
    if kind == "inlineCard":
        return {
            "type": "inlineCard",
            "attrs": randomizer.choice(
                [{"url": "https://x/y"}, {"data": {"url": "https://z"}}, {"data": {"name": "Card"}}, {}]
            ),
        }
    node: dict = {"type": kind}
    if randomizer.random() < 0.5:
        node["attrs"] = randomizer.choice([{"level": randomizer.randint(1, 6)}, {"language": "python"}, {}])
    node["content"] = [rand_adf(randomizer, depth + 1) for _ in range(randomizer.randint(0, 3))]
    return node


def rand_team(randomizer: random.Random):
    shapes = [
        lambda: {"id": str(randomizer.randint(1, 999))},
        lambda: {"id": randomizer.randint(1, 999), "name": "T"},
        lambda: {"value": randomizer.choice(["TeamX", "Team X", "t_1"])},
        lambda: {"name": "N", "self": "https://jira/x"},
        lambda: {"name": "OnlyName"},
        lambda: randomizer.randint(1, 999),
        lambda: "team-%d" % randomizer.randint(1, 99),
        lambda: None,
        lambda: [{"id": str(randomizer.randint(1, 99))}],
        lambda: {"value": {"id": str(randomizer.randint(1, 99))}},
        lambda: '{"data":[{"teamId":"t%d"}]}' % randomizer.randint(1, 9),
        lambda: [{"id": "a"}, {"id": "a"}],
        lambda: {},
    ]
    return randomizer.choice(shapes)()


def rand_link(randomizer: random.Random) -> dict:
    link: dict = {}
    if randomizer.random() < 0.8:
        link["id"] = str(randomizer.randint(1, 999))
    if randomizer.random() < 0.8:
        link_type: dict = {}
        if randomizer.random() < 0.8:
            link_type["id"] = str(randomizer.randint(1, 20))
        if randomizer.random() < 0.8:
            link_type["name"] = randomizer.choice(["Blocks", "Relates", "Blocker", "Relation", "Random"])
        if randomizer.random() < 0.6:
            link_type["inward"] = randomizer.choice(["is blocked by", "relates to", ""])
        if randomizer.random() < 0.6:
            link_type["outward"] = "blocks"
        link["type"] = link_type
    for key in ("inwardIssue", "outwardIssue"):
        if randomizer.random() < 0.5:
            other: dict = {"key": "RHCLOUD-%d" % randomizer.randint(1, 99)}
            if randomizer.random() < 0.7:
                other["id"] = str(randomizer.randint(1, 999))
            if randomizer.random() < 0.5:
                other["fields"] = {
                    "summary": rand_text(randomizer),
                    "status": {"name": randomizer.choice(["New", "Done"])},
                }
                if randomizer.random() < 0.3:
                    other["fields"]["priority"] = {"name": "High"}
            link[key] = other
    return link


def rand_issue(randomizer: random.Random, index: int) -> dict:
    return {
        "key": "RHCLOUD-%d" % (index + 1),
        "fields": {
            "parent": {"key": "RHCLOUD-1"},
            TEAM_FIELD_ID: rand_team(randomizer),
            "summary": "S%d %s" % (index, rand_text(randomizer)),
            "description": randomizer.choice(
                [None, "", rand_text(randomizer), rand_adf(randomizer), {"version": 1, "type": "doc", "content": []}]
            ),
            "updated": randomizer.choice([None, "2026-11-2%dT10:00:00.000+0000" % (index % 10)]),
            "priority": randomizer.choice([None, {}, {"name": "High"}, {"id": "3"}, {"name": "P", "id": "3"}]),
            "issuetype": randomizer.choice([None, {}, {"name": "Story"}, {"id": "3"}]),
            "status": {"name": randomizer.choice(["New", "In Progress", "Done"])},
            "labels": randomizer.choice([[], ["phase:01"], ["phase:01", "triaged"], ["repo:demo", "phase:02"]]),
            "issuelinks": [rand_link(randomizer) for _ in range(randomizer.randint(0, 3))],
            "assignee": randomizer.choice(
                [None, {"displayName": "X", "name": "x"}, {"display_name": "Unassigned"}]
            ),
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fabric", required=True, help="path to the Fabric project_coordinator.py")
    parser.add_argument("--out", required=True, help="output JSON path (parity-goldens schema)")
    parser.add_argument("--count", type=int, default=200)
    parser.add_argument("--seed", type=int, default=692021)
    args = parser.parse_args()

    randomizer = random.Random(args.seed)
    fabric = load_project_coordinator(args.fabric)
    cases = []
    for run in range(args.count):
        rest_issues = [rand_issue(randomizer, i) for i in range(randomizer.randint(1, 4))]
        issues = mcp_issues(rest_issues)
        snapshot = fabric.ticket_plan_snapshot(issues, TEAM_FIELD_ID, IMPLEMENTATION_LABEL)
        cases.append(
            {
                "name": "fuzz-%03d" % run,
                "team_field_id": TEAM_FIELD_ID,
                "implementation_label": IMPLEMENTATION_LABEL,
                "rest": rest_issues,
                "mcp": [
                    {key: issue[key] for key in ("key", "description", TEAM_FIELD_ID, "issuelinks") if key in issue}
                    for issue in issues
                ],
                "snapshot": snapshot,
                "digest": fabric.ticket_plan_digest(snapshot),
            }
        )
    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump({"cases": cases}, handle, ensure_ascii=False)
    print("wrote %d fuzz cases to %s" % (len(cases), args.out))


if __name__ == "__main__":
    main()
