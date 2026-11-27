#!/usr/bin/env python3
"""Generate the REST-vs-MCP parity goldens for the fabric-project-state preflight.

Each case holds raw REST-shaped Jira issues. The pipeline below runs them
through the REAL deployed mcp-atlassian server models (JiraSearchResult ->
JiraIssue.to_simplified_dict, exactly what the jira_search tool returns as
JSON) and then through the REAL Fabric coordinator Python
(project_coordinator.ticket_plan_snapshot / ticket_plan_digest, the functions
actions.py uses to recompute approval hashes). The emitted golden file pins:

  - rest:      the raw REST issues (single source of fixtures for the TS test)
  - mcp:       the server-side projection the TS ports must reproduce
               (description, the wrapped team custom field, simplified links)
  - snapshot:  the Fabric Python plan snapshot over the MCP issues
  - digest:    sha256 of the snapshot (the approval plan hash)
  - planner_snapshot: the Fabric Python planner_ticket_snapshot over the MCP
               issues (scope-only inputs; planner-assigned phase/repo labels
               are outputs and excluded)
  - planner_digest: sha256 of the planner snapshot (input_snapshot_hash the
               planner publishes and current_planner_plan validates)

The TypeScript preflight must produce the same snapshot and digest from the
`rest` issues, proving a REST read digests identically to the deployed
MCP path without running any live Jira call.

Platform note: generate on Linux for exact production parity. The deployed
server runs on glibc (ubi9 proxy container), where datetime.strftime("%Y")
does NOT zero-pad years below 1000 ("481-10-30"); macOS Python pads
("0481-10-30"). The corpus therefore avoids year<1000 dates, and the
TypeScript port matches the glibc format.

Requirements to regenerate:
  - Python >= 3.10
  - mcp-atlassian==0.23.1 (PyPI sdist sha256
    6b57391928887f5334fe854073b09e3a49bb7dae0d55a1b1276f4d910607a0f1 —
    the version pinned by rehor proxy/Dockerfile and running in devbot-proxy)
  - the Fabric project_coordinator.py checkout, e.g.
    fabric-access-ai-dev at d62cc55 (planner-owned coordinator plans):
    instance/rbac-project-coordinator/agent/workflows/project-coordinator/project_coordinator.py

Usage:
  python3 generate.py --fabric /path/to/project_coordinator.py \
      --out "$(dirname "$0")/parity-goldens.json"
"""

from __future__ import annotations

import argparse
import importlib.metadata
import importlib.util
import json
import sys
import types

BASE_URL = "https://redhat.atlassian.net"
TEAM_FIELD_ID = "customfield_10001"
IMPLEMENTATION_LABEL = "implementation-bot"


def load_project_coordinator(path: str):
    """Import project_coordinator.py with its jira_mcp/common imports stubbed."""
    jira_mcp = types.ModuleType("jira_mcp")
    jira_mcp.jira_call = lambda *args, **kwargs: None
    jira_mcp.jira_cleanup = lambda: None
    sys.modules["jira_mcp"] = jira_mcp
    common = types.ModuleType("common")
    common.INSTANCE_ID = ""
    common.MEMORY_URL = ""
    common.http_get = lambda *args, **kwargs: {}
    common.load_project_repos = lambda: {}
    common.output_result = lambda *args, **kwargs: None
    sys.modules["common"] = common
    spec = importlib.util.spec_from_file_location("project_coordinator", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def mcp_issues(rest_issues: list[dict]) -> list[dict]:
    """Run the real mcp-atlassian 0.23.1 search pipeline over REST issues."""
    from mcp_atlassian.models.jira import JiraSearchResult

    # The Cloud branch of SearchMixin.search_issues builds this exact response
    # dict (total is always -1; nextPageToken only when more pages remain).
    response = {"issues": rest_issues, "total": -1, "startAt": 0, "maxResults": 50}
    result = JiraSearchResult.from_api_response(response, base_url=BASE_URL, requested_fields="*all")
    # The tool layer returns json.dumps(..., indent=2, ensure_ascii=False) and
    # the Fabric wrapper json.loads()s it verbatim.
    payload = json.dumps(result.to_simplified_dict(), indent=2, ensure_ascii=False)
    issues = json.loads(payload)["issues"]
    if not isinstance(issues, list):
        raise SystemExit("model returned no issue list")
    return issues


def ticket(number: int, **extra) -> dict:
    fields = {
        "parent": {"key": "RHCLOUD-1"},
        TEAM_FIELD_ID: {"id": "team-1"},
        "summary": f"Ticket {number}",
        "description": None,
        "updated": None,
        "priority": None,
        "issuetype": None,
        "status": {"name": "New"},
        "labels": ["phase:01"],
        "issuelinks": [],
        "assignee": None,
    }
    fields.update(extra)
    return {"key": f"RHCLOUD-{number}", "fields": fields}


def adf(node_type: str, value: str) -> dict:
    return {
        "type": "doc",
        "version": 1,
        "content": [{"type": node_type, "content": [{"type": "text", "text": value}]}],
    }


def cases() -> list[dict]:
    parity_child = dict(
        summary="First implementation ticket",
        description="Clear acceptance criteria",
        updated="2026-11-21T10:00:00.000+0000",
        priority={"name": "Medium", "id": "3"},
        issuetype={"name": "Story"},
        labels=["phase:01"],
        issuelinks=[{"type": {"name": "Relates"}, "outwardIssue": {"key": "RHCLOUD-2"}}],
        **{TEAM_FIELD_ID: {"id": "42"}},
    )
    team_shapes = [
        ("gh-team", {"id": "42", "name": "Access"}),
        ("select-like", {"value": "Team X", "id": "7"}),
        ("name-with-self", {"name": "Plain Field", "self": "https://jira/rest/api/2/user"}),
        ("name-only", {"name": "No Self"}),
        ("bare-number", 42),
        ("bare-string", "team-abc_123"),
        ("null", None),
        ("list-of-one", [{"id": "7"}]),
        ("json-string", '{"data":[{"teamId":"team-1"}]}'),
        ("nested-value", {"value": {"id": "9"}}),
    ]
    return [
        {
            "name": "plain-converges",
            "issues": [
                ticket(
                    7,
                    summary="Shared summary",
                    description="Plain text",
                    updated="2026-11-23T12:00:00.000+0000",
                    priority={"name": "High", "id": "3"},
                    issuetype={"name": "Story"},
                    labels=["phase:01", "triaged"],
                )
            ],
        },
        {
            "name": "adf-paragraph-two-texts",
            "issues": [
                ticket(
                    4,
                    description={
                        "version": 1,
                        "type": "doc",
                        "content": [
                            {
                                "type": "paragraph",
                                "content": [
                                    {"type": "text", "text": "hello "},
                                    {"type": "text", "text": "world"},
                                ],
                            }
                        ],
                    },
                )
            ],
        },
        {
            "name": "adf-rich-blocks",
            "issues": [
                ticket(
                    4,
                    description={
                        "version": 1,
                        "type": "doc",
                        "content": [
                            {"type": "paragraph", "content": [{"type": "text", "text": "intro"}]},
                            {
                                "type": "codeBlock",
                                "attrs": {"language": "python"},
                                "content": [{"type": "text", "text": "x=1"}],
                            },
                            {
                                "type": "heading",
                                "attrs": {"level": 2},
                                "content": [{"type": "text", "text": "Heading"}],
                            },
                            {
                                "type": "bulletList",
                                "content": [
                                    {
                                        "type": "listItem",
                                        "content": [
                                            {
                                                "type": "paragraph",
                                                "content": [{"type": "text", "text": "item"}],
                                            }
                                        ],
                                    }
                                ],
                            },
                            {
                                "type": "paragraph",
                                "content": [
                                    {"type": "text", "text": "break"},
                                    {"type": "hardBreak"},
                                    {"type": "text", "text": "after"},
                                ],
                            },
                            {
                                "type": "paragraph",
                                "content": [
                                    {
                                        "type": "mention",
                                        "attrs": {"id": "accountid:1", "text": "@Martin"},
                                    },
                                    {"type": "emoji", "attrs": {"shortName": ":coffee:"}},
                                    {"type": "status", "attrs": {"text": "LOVE"}},
                                    {"type": "date", "attrs": {"timestamp": 1732712400000}},
                                    {
                                        "type": "inlineCard",
                                        "attrs": {"url": "https://example.com/card"},
                                    },
                                ],
                            },
                        ],
                    },
                )
            ],
        },
        {"name": "adf-empty-doc", "issues": [ticket(4, description={"version": 1, "type": "doc", "content": []})]},
        {
            "name": "adf-empty-text",
            "issues": [
                ticket(
                    4,
                    description={
                        "version": 1,
                        "type": "doc",
                        "content": [{"type": "paragraph", "content": [{"type": "text", "text": ""}]}],
                    },
                )
            ],
        },
        {"name": "description-null", "issues": [ticket(4, description=None)]},
        {"name": "description-empty-string", "issues": [ticket(4, description="")]},
        {
            "name": "team-shapes",
            "issues": [
                ticket(20 + index, summary=f"Team shape {name}", **{TEAM_FIELD_ID: value})
                for index, (name, value) in enumerate(team_shapes)
            ],
        },
        {
            "name": "links-blocks-inward",
            "issues": [
                ticket(
                    4,
                    issuelinks=[
                        {
                            "id": "11",
                            "type": {"id": "5", "name": "Blocks", "inward": "is blocked by", "outward": "blocks"},
                            "inwardIssue": {
                                "id": "9",
                                "key": "RHCLOUD-9",
                                "fields": {"summary": "Other", "status": {"name": "Done"}},
                            },
                        }
                    ],
                )
            ],
        },
        {
            "name": "links-relates-outward",
            "issues": [ticket(4, issuelinks=[{"type": {"name": "Relates"}, "outwardIssue": {"key": "RHCLOUD-8"}}])],
        },
        {"name": "links-no-type", "issues": [ticket(4, issuelinks=[{"id": "1", "inwardIssue": {"key": "RHCLOUD-9"}}])]},
        {
            "name": "links-status-category",
            "issues": [
                ticket(
                    4,
                    issuelinks=[
                        {
                            "type": {"name": "Blocks", "inward": "is blocked by"},
                            "inwardIssue": {
                                "id": "9",
                                "key": "RHCLOUD-9",
                                "fields": {
                                    "summary": "Cat",
                                    "status": {
                                        "name": "Done",
                                        "statusCategory": {"name": "Done", "colorName": "green"},
                                    },
                                },
                            },
                        },
                        {
                            "type": {"name": "Relates"},
                            "outwardIssue": {
                                "id": "8",
                                "key": "RHCLOUD-8",
                                "fields": {"summary": "Str", "status": {"name": "New", "statusCategory": "garbage"}},
                            },
                        },
                        {
                            "type": {"name": "Relates"},
                            "outwardIssue": {
                                "id": "7",
                                "key": "RHCLOUD-7",
                                "fields": {"summary": "Empty", "status": {"name": "New", "statusCategory": {}}},
                            },
                        },
                    ],
                )
            ],
        },
        {
            "name": "links-mixed",
            "issues": [
                ticket(
                    4,
                    issuelinks=[
                        {"type": {"name": "Blocks", "inward": "blocks"}, "outwardIssue": {"key": "RHCLOUD-7"}},
                        {"type": {"name": "Relates"}, "inwardIssue": {"key": "RHCLOUD-8", "id": "8"}},
                        None,
                        {"key": "dropped-non-object"},
                        {"inwardIssue": {"key": "RHCLOUD-6"}},
                    ],
                )
            ],
        },
        {"name": "labels-empty", "issues": [ticket(4, labels=[])]},
        {
            "name": "summary-null-and-missing",
            "issues": [
                ticket(4, summary=None),
                {key: value for key, value in ticket(5).items() if key != "fields"}
                | {"fields": {key: value for key, value in ticket(5)["fields"].items() if key != "summary"}},
            ],
        },
        {
            "name": "adf-date-strings",
            "issues": [
                ticket(
                    4,
                    description={
                        "version": 1,
                        "type": "doc",
                        "content": [
                            {"type": "date", "attrs": {"timestamp": " 42 "}},
                            {"type": "date", "attrs": {"timestamp": "1_000"}},
                            {"type": "date", "attrs": {"timestamp": "not-a-number"}},
                            {"type": "date", "attrs": {"timestamp": 253402300800000}},
                        ],
                    },
                )
            ],
        },
        {
            "name": "priority-issuetype-defaults",
            "issues": [
                ticket(4, priority={"id": "3"}, issuetype={}),
                ticket(5, priority={"name": ""}, issuetype={"name": ""}),
            ],
        },
        {
            "name": "scenario-default",
            "issues": [
                ticket(3, labels=["repo:demo", "phase:01", IMPLEMENTATION_LABEL]),
                ticket(4),
                ticket(5, issuelinks=[{"type": {"name": "Blocks"}, "inwardIssue": {"key": "RHCLOUD-9"}}]),
            ],
        },
        {"name": "scenario-parity", "issues": [ticket(3, **parity_child)]},
        {
            "name": "scenario-adf",
            "issues": [
                ticket(
                    4,
                    description=adf("paragraph", "café's 🧶\nworks"),
                    updated="2026-11-23T12:00:00.000+0000",
                    priority={"id": "1", "name": "High"},
                    issuetype={"name": "Task"},
                    assignee={"display_name": "Unassigned"},
                    issuelinks=[{"type": {"name": "Relates"}, "outwardIssue": {"key": "RHCLOUD-8"}}],
                )
            ],
        },
        {
            "name": "scenario-handedoff",
            "issues": [ticket(3, **{**parity_child, "labels": ["phase:01", "triaged", IMPLEMENTATION_LABEL]})],
        },
    ]


def projection(issue: dict) -> dict:
    """The server-side values the TS ports must reproduce exactly."""
    result = {"key": issue.get("key")}
    if "description" in issue:
        result["description"] = issue["description"]
    if TEAM_FIELD_ID in issue:
        result[TEAM_FIELD_ID] = issue[TEAM_FIELD_ID]
    if "issuelinks" in issue:
        result["issuelinks"] = issue["issuelinks"]
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--fabric",
        required=True,
        help="path to the Fabric project_coordinator.py (fabric-access-ai-dev checkout)",
    )
    parser.add_argument(
        "--fabric-ref",
        default="fabric-access-ai-dev@d62cc55",
        help="provenance recorded in the golden file instead of the local path",
    )
    parser.add_argument("--out", required=True, help="output golden JSON path")
    args = parser.parse_args()

    mcp_version = importlib.metadata.version("mcp-atlassian")
    if mcp_version != "0.23.1":
        raise SystemExit(f"expected mcp-atlassian 0.23.1, found {mcp_version}")
    atlassian_version = importlib.metadata.version("atlassian-python-api")

    fabric = load_project_coordinator(args.fabric)

    generated = []
    for case in cases():
        rest_issues = case["issues"]
        issues = mcp_issues(rest_issues)
        snapshot = fabric.ticket_plan_snapshot(issues, TEAM_FIELD_ID, IMPLEMENTATION_LABEL)
        digest = fabric.ticket_plan_digest(snapshot)
        planner_snapshot = fabric.planner_ticket_snapshot(issues, TEAM_FIELD_ID)
        planner_digest = fabric.ticket_plan_digest(planner_snapshot)
        # Determinism guard: the same inputs must digest identically twice.
        again = fabric.ticket_plan_digest(
            fabric.ticket_plan_snapshot(
                mcp_issues(json.loads(json.dumps(rest_issues))), TEAM_FIELD_ID, IMPLEMENTATION_LABEL
            )
        )
        if again != digest:
            raise SystemExit(f"non-deterministic digest for case {case['name']}")
        planner_again = fabric.ticket_plan_digest(
            fabric.planner_ticket_snapshot(mcp_issues(json.loads(json.dumps(rest_issues))), TEAM_FIELD_ID)
        )
        if planner_again != planner_digest:
            raise SystemExit(f"non-deterministic planner digest for case {case['name']}")
        generated.append(
            {
                "name": case["name"],
                "team_field_id": TEAM_FIELD_ID,
                "implementation_label": IMPLEMENTATION_LABEL,
                "rest": rest_issues,
                "mcp": [projection(issue) for issue in issues],
                "snapshot": snapshot,
                "digest": digest,
                "planner_snapshot": planner_snapshot,
                "planner_digest": planner_digest,
            }
        )

    golden = {
        "generator": {
            "mcp_atlassian": mcp_version,
            "atlassian_python_api": atlassian_version,
            "python": sys.version.split()[0],
            "fabric_project_coordinator": args.fabric_ref,
            "note": "generated by test/fixtures/project-state-parity/generate.py; "
            "mcp-atlassian must be 0.23.1 (rehor proxy/Dockerfile pin); "
            "generate on Linux for exact year<1000 parity (see docstring)",
        },
        "cases": generated,
    }
    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(golden, handle, indent=2, ensure_ascii=False, sort_keys=True)
        handle.write("\n")
    print(f"wrote {args.out} with {len(generated)} cases")


if __name__ == "__main__":
    main()
