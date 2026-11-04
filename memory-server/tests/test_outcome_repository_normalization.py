"""Repository parity and lifecycle regressions; live tests use an isolated schema."""

import json
from contextlib import asynccontextmanager
from unittest.mock import AsyncMock, patch
from uuid import uuid4

import asyncpg
import pytest
import pytest_asyncio
from bot_memory_server.artifacts import build_artifacts
from bot_memory_server.models import OutcomeArtifact, OutcomeEvidence
from bot_memory_server.task_outcomes import (
    api_task_outcomes,
    api_task_outcomes_summary,
    canonical_repositories,
)
from bot_memory_server.tools.tasks import register_task_tools
from conftest import DB_CONFIG, SCHEMA_PATH
from fastmcp import Client, FastMCP
from httpx import ASGITransport, AsyncClient
from starlette.applications import Starlette
from starlette.routing import Route

CASES = [
    pytest.param(
        "fork/app",
        [{"url": "https://gitlab.example/group%2Fsubgroup%2Fapp/-/merge_requests/12"}],
        ["group/subgroup/app"],
        id="encoded-gitlab-subgroup",
    ),
    pytest.param("fork/app", [{"repo": " /upstream/app.git/ "}], ["upstream/app"], id="repo-only-legacy"),
    pytest.param(
        "fork/app",
        [
            {
                "baseRepo": " /upstream/app.git/ ",
                "repo": "fork/app",
                "headRepo": "fork/app",
                "url": "https://github.com/url/repo/pull/1",
            }
        ],
        ["upstream/app"],
        id="explicit-base-over-fork-and-url",
    ),
    pytest.param(" \t/fallback/app.git/\n", [], ["fallback/app"], id="missing-repo-fallback"),
    pytest.param(
        None,
        [
            {
                "url": " https://gitlab.example/gr%C3%BCppe%2F%E5%BA%94%E7%94%A8.git/-/merge_requests/1?x=/wrong/repo#fragment "
            }
        ],
        ["grüppe/应用"],
        id="unicode-query-fragment",
    ),
    pytest.param(
        "fallback/repo",
        [{"url": "https://github.com/upstream/app.git/pulls/2?target=wrong#fork", "repo": "fork/app"}],
        ["upstream/app"],
        id="github-url-over-legacy-repo",
    ),
    pytest.param(None, [{"target_project": "\u2003/组/app.git/\u00a0"}], ["组/app"], id="unicode-whitespace"),
    pytest.param(
        None, [{"canonicalRepo": " /org/app.git/?query#fragment "}], ["org/app"], id="explicit-query-fragment"
    ),
    pytest.param(None, [{"baseRepo": " / ", "targetRepo": "org/app"}], ["org/app"], id="blank-base-skipped"),
    pytest.param(
        "org/fallback", [{"repo": "fork/app", "sourceProject": "fork/app"}], ["org/fallback"], id="ambiguous-source"
    ),
    pytest.param("org/fallback", [{"headRepo": "fork/app"}], ["org/fallback"], id="head-never-canonical"),
    pytest.param(None, [{"repo": "org/app", "headRepo": ""}], ["org/app"], id="empty-head-not-ambiguous"),
    pytest.param(
        None, [{"repo": "z/app"}, {"repo": "a/app"}, {"repo": "/z/app.git/"}], ["a/app", "z/app"], id="deduplicate-sort"
    ),
    pytest.param(" / .git/ ", [], [], id="empty-fallback"),
    pytest.param(
        None, [{"url": "https://gitlab.example/group/app/merge_requests/3"}], ["group/app"], id="old-gitlab-marker"
    ),
    pytest.param(
        None, [{"url": "https://gitlab.example/group%2fapp/-/merge_requests/3"}], ["group/app"], id="lowercase-encoding"
    ),
    pytest.param(
        None, [{"url": "https://gitlab.example/group%252Fapp/-/merge_requests/3"}], ["group%2Fapp"], id="decode-once"
    ),
    pytest.param(
        None,
        [{"url": "https://gitlab.example/group%ZZ/app/-/merge_requests/3"}],
        ["group%ZZ/app"],
        id="invalid-percent",
    ),
    pytest.param(
        None,
        [{"url": "https://gitlab.example/group/%E2%82%FFapp/-/merge_requests/3"}],
        ["group/��app"],
        id="invalid-utf8",
    ),
    pytest.param(
        None, [{"url": "https://gitlab.example/group/%00app/-/merge_requests/3"}], ["group/�app"], id="nul-safe"
    ),
    pytest.param(
        "org/fallback", [None, "not-an-object", {"baseRepo": 123, "url": []}], ["org/fallback"], id="malformed-legacy"
    ),
    pytest.param(
        None,
        [
            {"url": "https://github.com/inferred/app/pull/1"},
            {"url": "https://github.com/inferred/app/pull/1", "baseRepo": "explicit/app"},
        ],
        ["explicit/app"],
        id="duplicate-url-explicit-beats-inferred",
    ),
    pytest.param(
        None,
        [
            {"url": "https://github.com/inferred/app/pull/1", "baseRepo": "explicit/app"},
            {"url": "https://github.com/inferred/app/pull/1"},
        ],
        ["explicit/app"],
        id="later-thin-url-does-not-displace-explicit",
    ),
    pytest.param(
        None,
        [
            {"url": "https://github.com/inferred/app/pull/1", "baseRepo": "old/app"},
            {"url": "https://github.com/inferred/app/pull/1", "targetProject": "new/app"},
        ],
        ["new/app"],
        id="explicit-tie-later-alias-wins",
    ),
    pytest.param(
        None,
        [
            {"url": " https://github.com/inferred/app/pull/1 ", "baseRepo": "old/app"},
            {"url": "https://github.com/inferred/app/pull/1", "canonical_repo": "new/app"},
        ],
        ["new/app"],
        id="url-identity-trims-whitespace",
    ),
    pytest.param(
        None,
        [
            {"url": "https://github.com/inferred/app/pull/1", "baseRepo": "explicit/one"},
            {"url": "https://github.com/inferred/app/pull/2", "targetRepo": "explicit/two"},
        ],
        ["explicit/one", "explicit/two"],
        id="distinct-urls-retain-multiple-repos",
    ),
    pytest.param(
        None,
        [
            {"type": "github_pr", "id": "1", "repo": "old/app"},
            {"type": "github_pr", "id": "1", "targetRepo": "new/app"},
        ],
        ["new/app"],
        id="typed-id-explicit-beats-legacy",
    ),
    pytest.param(
        None,
        [
            {"type": "github_pr", "id": "1", "baseRepo": "old/app"},
            {"type": "github_pr", "id": "1", "targetRepo": "new/app"},
        ],
        ["new/app"],
        id="typed-id-explicit-tie-later-wins",
    ),
    pytest.param(
        None,
        [{"type": "github_pr", "id": "1", "repo": "old/app"}, {"type": "gitlab_mr", "id": "1", "repo": "other/app"}],
        ["old/app", "other/app"],
        id="same-id-different-type-independent",
    ),
    pytest.param(
        None,
        [{"id": "1", "repo": "one/app"}, {"id": "1", "repo": "two/app"}],
        ["one/app", "two/app"],
        id="untyped-id-does-not-collapse-repositories",
    ),
    pytest.param(
        None,
        [{"url": "provider-ref", "repo": "old/app"}, {"url": "provider-ref", "repo": "new/app"}],
        ["new/app"],
        id="legacy-tie-later-wins",
    ),
    pytest.param(
        None,
        [{"url": "provider-ref", "baseRepo": "old/app"}, {"url": "provider-ref", "headRepo": "fork/app"}],
        ["old/app"],
        id="missing-candidate-does-not-displace-known-target",
    ),
]


@pytest.mark.parametrize(("task_repo", "artifacts", "expected"), CASES)
def test_python_canonical_repository_normalization(task_repo, artifacts, expected):
    assert canonical_repositories(task_repo, artifacts) == expected


@pytest.mark.parametrize(
    "key",
    [
        "baseRepo",
        "base_repo",
        "targetProject",
        "target_project",
        "targetRepo",
        "target_repo",
        "canonicalRepo",
        "canonical_repo",
    ],
)
def test_all_explicit_repository_aliases_override_fork(key):
    assert canonical_repositories("fork/app", [{key: "/upstream/app.git/", "headRepo": "fork/app"}]) == ["upstream/app"]


@pytest.mark.parametrize(
    "key",
    [
        "headRepo",
        "head_repo",
        "headProject",
        "head_project",
        "sourceRepo",
        "source_repo",
        "sourceProject",
        "source_project",
        "forkRepo",
        "fork_repo",
    ],
)
def test_legacy_repo_is_not_canonical_when_source_is_ambiguous(key):
    assert canonical_repositories("upstream/app", [{"repo": "fork/app", key: "fork/app"}]) == ["upstream/app"]


class ConnectionPool:
    def __init__(self, conn):
        self.conn = conn

    @asynccontextmanager
    async def acquire(self):
        yield self.conn

    def __getattr__(self, name):
        return getattr(self.conn, name)


@pytest_asyncio.fixture
async def repository_db():
    """No destructive shared db fixture: roll back a private schema after each test."""
    conn = await asyncpg.connect(**DB_CONFIG)
    transaction = conn.transaction()
    await transaction.start()
    try:
        schema = f"outcome_repository_{uuid4().hex}"
        await conn.execute(f'CREATE SCHEMA "{schema}"')
        await conn.execute(f'SET LOCAL search_path TO "{schema}", public')
        schema_sql = SCHEMA_PATH.read_text()
        await conn.execute(schema_sql)
        # Exercise installation over an existing schema, including trigger replacement.
        await conn.execute(schema_sql)
        yield ConnectionPool(conn)
    finally:
        await transaction.rollback()
        await conn.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(("task_repo", "artifacts", "expected"), CASES)
async def test_sql_python_repository_parity_real_database(repository_db, task_repo, artifacts, expected):
    actual = await repository_db.fetchval(
        "SELECT outcome_canonical_repositories($1, $2::jsonb)", task_repo, json.dumps(artifacts)
    )
    assert json.loads(actual) == canonical_repositories(task_repo, artifacts) == expected


LIFECYCLE_CASES = [
    pytest.param(
        "fork/app",
        {},
        [{"type": "merge_request", "url": "https://gitlab.example/group%2Fsubgroup%2Fapp/-/merge_requests/1"}],
        ["group/subgroup/app"],
        id="encoded-subgroup",
    ),
    pytest.param(
        "fork/app", {"prs": [{"repo": " /upstream/legacy.git/ "}]}, [], ["upstream/legacy"], id="repo-only-legacy-prs"
    ),
    pytest.param(
        "fork/app",
        {
            "prs": [
                {
                    "repo": "fork/app",
                    "baseRepo": " /upstream/base.git/ ",
                    "headRepo": "fork/app",
                    "url": "https://github.com/upstream/base/pull/1",
                    "extra": "retained",
                }
            ]
        },
        None,
        ["upstream/base"],
        id="legacy-explicit-base-fork",
    ),
    pytest.param(" \t/fallback/app.git/\n", {}, [], ["fallback/app"], id="trimmed-task-fallback"),
    pytest.param(
        None,
        {
            "prs": [
                {
                    "url": "https://gitlab.example/gr%C3%BCppe%2F%E5%BA%94%E7%94%A8.git/-/merge_requests/2?x=wrong#fragment"
                }
            ]
        },
        None,
        ["grüppe/应用"],
        id="unicode-query-fragment",
    ),
    pytest.param(
        "fallback/app",
        {"prs": [{"repo": "upstream/one"}, {"repo": "upstream/two"}]},
        [],
        ["upstream/one", "upstream/two"],
        id="multi-repo-legacy",
    ),
    pytest.param(
        "fallback/app",
        {"prs": [{"url": "https://github.com/fork/app/pull/1", "baseRepo": "upstream/app", "headRepo": "fork/app"}]},
        None,
        ["upstream/app"],
        id="thin-stored-url-richer-legacy-target",
    ),
    pytest.param(
        "fallback/app",
        {
            "prs": [
                {"url": "https://github.com/fork/app/pull/1", "targetRepo": "upstream/one"},
                {"url": "https://github.com/fork/app/pull/2", "targetRepo": "upstream/two"},
            ]
        },
        None,
        ["upstream/one", "upstream/two"],
        id="distinct-legacy-urls-multi-repo",
    ),
]

app = Starlette(
    routes=[
        Route("/tasks", api_task_outcomes),
        Route("/summary", api_task_outcomes_summary),
    ]
)


@pytest.mark.asyncio
@pytest.mark.parametrize(("task_repo", "metadata", "artifacts", "expected"), LIFECYCLE_CASES)
@pytest.mark.parametrize("initial_status", ["in_progress", "done"])
async def test_reporting_preserves_repository_rollups_real_database(
    repository_db,
    task_repo,
    metadata,
    artifacts,
    expected,
    initial_status,
):
    pool = repository_db
    artifacts = build_artifacts(metadata) if artifacts is None else artifacts
    task_id = await pool.fetchval(
        "INSERT INTO tasks (external_key, source_type, status, repo, artifacts, metadata) "
        "VALUES ('NORMALIZE-1', 'manual', $1::task_status, $2, $3::jsonb, $4::jsonb) RETURNING id",
        initial_status,
        task_repo,
        json.dumps(artifacts),
        json.dumps(metadata),
    )
    # Unrelated row makes wrong-repository filtering and pagination observable.
    await pool.execute("INSERT INTO tasks (external_key, source_type, repo) VALUES ('OTHER-1', 'manual', 'other/repo')")
    mcp = FastMCP(name="repository-normalization")
    register_task_tools(mcp)
    tools = {tool.name: tool.fn for tool in await mcp.list_tools()}

    with (
        patch("bot_memory_server.tools.tasks.get_pool", return_value=pool),
        patch("bot_memory_server.task_outcomes.get_pool", return_value=pool),
        patch("bot_memory_server.tools.tasks.bus.publish", new_callable=AsyncMock),
    ):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:

            async def snapshot(state):
                listing = (await client.get("/tasks", params={"decision": state})).json()
                target = next(item for item in listing["items"] if item["taskId"] == task_id)
                assert target["canonicalRepositories"] == expected
                summary = (await client.get("/summary")).json()
                groups = {row["repo"]: row["taskCount"] for row in summary["repositories"]}
                assert summary["summary"]["repositoryCount"] == len(expected) + 1
                assert groups == dict.fromkeys([*expected, "other/repo"], 1)
                for repo in expected:
                    params = {"repo": repo, "limit": 1}
                    filtered = (await client.get("/tasks", params=params)).json()
                    assert filtered["total"] == 1
                    assert [item["taskId"] for item in filtered["items"]] == [task_id]
                    empty_page = (await client.get("/tasks", params={**params, "offset": 1})).json()
                    assert empty_page["total"] == 1 and empty_page["items"] == []
                    filtered_summary = (await client.get("/summary", params={"repo": repo})).json()
                    assert filtered_summary["summary"]["taskCount"] == 1
                    for row in filtered_summary["repositories"]:
                        assert row[f"{state}Count"] == 1
                if "fork/app" not in expected:
                    assert (await client.get("/tasks", params={"repo": "fork/app"})).json()["total"] == 0
                return groups

            state = "wip" if initial_status == "in_progress" else "unreported"
            before = await snapshot(state)
            report = await tools["task_outcome_report"](
                external_key="NORMALIZE-1",
                source_type="manual",
                artifacts=[],
                evidence=[
                    OutcomeEvidence(
                        source="manual",
                        reference="NORMALIZE-1",
                        resolution="accepted",
                        disposition="Delivered",
                        reason="Verified delivery",
                    )
                ],
                notes=None,
            )
            assert report["outcome"]["canonicalRepositories"] == expected
            # Snapshot extraction must not enrich or rewrite report artifact extras.
            assert all(
                "baseRepo" not in artifact and "repo" not in artifact for artifact in report["outcome"]["artifacts"]
            )
            assert json.loads(await pool.fetchval("SELECT metadata FROM tasks WHERE id = $1", task_id)) == metadata
            if initial_status == "in_progress":
                assert await snapshot("wip") == before
            await tools["task_remove"](external_key="NORMALIZE-1", source_type="manual")
            assert await snapshot("accepted") == before


@pytest.mark.asyncio
async def test_monitoring_category_is_counted_separately_and_excluded_from_metrics(repository_db):
    pool = repository_db
    for key, category in (("DELIVERY-1", "delivery"), ("WATCH-1", "monitoring")):
        task_id = await pool.fetchval(
            "INSERT INTO tasks (external_key, source_type, status, category, repo) "
            "VALUES ($1, 'manual', 'done', $2, 'org/service') RETURNING id",
            key,
            category,
        )
        report_id = await pool.fetchval(
            "INSERT INTO task_outcome_reports (task_id, decision, confidence, reason) "
            "VALUES ($1, 'accepted', 'conclusive', 'verified') RETURNING id",
            task_id,
        )
        await pool.execute("UPDATE tasks SET outcome_report_id = $1 WHERE id = $2", report_id, task_id)

    with patch("bot_memory_server.task_outcomes.get_pool", return_value=pool):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            response = await client.get("/summary")
            monitoring_only = await client.get("/summary?category=monitoring")

    summary = response.json()["summary"]
    assert summary["taskCount"] == 2
    assert summary["deliveryTaskCount"] == 1
    assert summary["monitoringCount"] == 1
    assert summary["acceptedCount"] == 1
    assert summary["acceptanceRate"] == 1.0
    assert summary["outcomeCoverage"] == 1.0
    assert response.json()["repositories"][0]["repo"] == "org/service"
    assert response.json()["repositories"][0]["monitoringCount"] == 1
    assert monitoring_only.json()["summary"]["taskCount"] == 1
    assert monitoring_only.json()["summary"]["monitoringCount"] == 1
    assert monitoring_only.json()["summary"]["acceptedCount"] == 0
    assert monitoring_only.json()["summary"]["acceptanceRate"] is None


@pytest.mark.asyncio
async def test_grooming_rollups_exclude_other_categories_and_preserve_delivery_metrics_real_database(repository_db):
    pool = repository_db
    grooming_counts = {
        "accepted": 2,
        "rejected": 3,
        "obsolete": 1,
        "inconclusive": 1,
        "unreported": 2,
        "wip": 1,
    }
    for category in ("delivery", "monitoring", "grooming"):
        for state, count in grooming_counts.items():
            for index in range(count if category == "grooming" else 1):
                key = f"{category}-{state}-{index}"
                artifacts = (
                    []
                    if category != "grooming"
                    else [
                        {"type": "review", "targetRepo": "org/service"},
                        {"type": "review", "targetRepo": "org/grooming-only"},
                        {"type": "review", "targetRepo": "org/service"},
                    ]
                )
                task_id = await pool.fetchval(
                    "INSERT INTO tasks (external_key, source_type, status, category, repo, artifacts) "
                    "VALUES ($1, 'manual', $2::task_status, $3, 'org/service', $4::jsonb) RETURNING id",
                    key,
                    "in_progress" if state == "wip" else "done",
                    category,
                    json.dumps(artifacts),
                )
                if state == "unreported":
                    continue  # Done alone must not become accepted.
                decision = "accepted" if state == "wip" else state
                report_id = await pool.fetchval(
                    "INSERT INTO task_outcome_reports (task_id, decision, confidence, reason, evidence) "
                    "VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING id",
                    task_id,
                    decision,
                    "inconclusive" if decision == "inconclusive" else "conclusive",
                    f"{category}-{decision}",
                    json.dumps(
                        [
                            {
                                "source": category,
                                "reference": key,
                                "resolution": (
                                    "unknown"
                                    if decision == "inconclusive"
                                    else "rejected"
                                    if decision == "rejected"
                                    else "accepted"
                                ),
                                "disposition": "Won't Do" if decision == "accepted" else decision,
                                "reason": "Explicitly adjudicated source evidence",
                            }
                        ]
                    ),
                )
                await pool.execute("UPDATE tasks SET outcome_report_id = $1 WHERE id = $2", report_id, task_id)

    with patch("bot_memory_server.task_outcomes.get_pool", return_value=pool):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            body = (await client.get("/summary")).json()
            summary = body["summary"]
            assert summary["taskCount"] == 22
            assert summary["deliveryTaskCount"] == summary["monitoringCount"] == 6
            assert summary["repositoryCount"] == 2
            for rollup in [summary, *body["repositories"]]:
                assert rollup["groomingCount"] == 10
                assert rollup["taskCount"] == sum(
                    rollup[field] for field in ("deliveryTaskCount", "monitoringCount", "groomingCount")
                )
                assert sum(rollup["groomingOutcomes"].values()) == rollup["groomingCount"]
                assert rollup["groomingOutcomes"] == {
                    f"{state}Count": count for state, count in grooming_counts.items()
                }
                delivery_repo = rollup.get("repo") != "org/grooming-only"
                assert rollup["acceptanceRate"] == (1 / 3 if delivery_repo else None)
                assert rollup["outcomeCoverage"] == (0.8 if delivery_repo else None)
                for state in grooming_counts:
                    assert rollup[f"{state}Count"] == int(delivery_repo)
                assert rollup["acceptedNoOpCount"] == int(delivery_repo)
            repositories = {row["repo"]: row for row in body["repositories"]}
            assert repositories["org/service"]["providers"] == {"delivery": 4}
            assert repositories["org/service"]["reasons"] == {
                f"delivery-{state}": 1 for state in ("accepted", "rejected", "obsolete", "inconclusive")
            }
            assert repositories["org/grooming-only"]["providers"] == {}
            assert repositories["org/grooming-only"]["reasons"] == {}
            for category, count in (("delivery", 6), ("monitoring", 6), ("grooming", 10)):
                filtered = (await client.get("/summary", params={"category": category})).json()["summary"]
                assert filtered["taskCount"] == count
                assert filtered["groomingCount"] == (10 if category == "grooming" else 0)
                assert filtered["acceptanceRate"] == (1 / 3 if category == "delivery" else None)
                assert filtered["outcomeCoverage"] == (0.8 if category == "delivery" else None)
            for state, count in grooming_counts.items():
                params = {"category": "grooming", "decision": state, "repo": "org/grooming-only"}
                listing = (await client.get("/tasks", params=params)).json()
                assert listing["total"] == len(listing["items"]) == count
                assert all(item["category"] == "grooming" and item["state"] == state for item in listing["items"])
                assert all(item["outcome"] is None for item in listing["items"] if state in {"unreported", "wip"})
                filtered = (await client.get("/summary", params=params)).json()["summary"]
                assert filtered["groomingCount"] == filtered["groomingOutcomes"][f"{state}Count"] == count
                assert sum(filtered["groomingOutcomes"].values()) == count
                assert filtered["acceptedCount"] == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("legacy_check", [False, True], ids=["fresh-schema", "two-value-upgrade"])
async def test_grooming_schema_upgrades_two_value_check_idempotently_real_database(repository_db, legacy_check):
    pool = repository_db
    if legacy_check:
        await pool.execute(
            "ALTER TABLE tasks DROP CONSTRAINT tasks_category_check; "
            "ALTER TABLE tasks ADD CONSTRAINT tasks_category_check CHECK (category IN ('delivery', 'monitoring'))"
        )
    task_id = await pool.fetchval(
        "INSERT INTO tasks (external_key, source_type, status, repo, archived_at) "
        "VALUES ('UPGRADE-1', 'manual', 'archived', 'org/service', NOW()) RETURNING id"
    )
    await pool.execute(
        "INSERT INTO tasks (external_key, source_type, category) VALUES ('UPGRADE-WATCH', 'manual', 'monitoring')"
    )
    report_id = await pool.fetchval(
        "INSERT INTO task_outcome_reports (task_id, decision, confidence, reason) "
        "VALUES ($1, 'inconclusive', 'inconclusive', 'Awaiting qualification') RETURNING id",
        task_id,
    )
    await pool.execute("UPDATE tasks SET outcome_report_id = $1 WHERE id = $2", report_id, task_id)
    before = await pool.fetchrow("SELECT * FROM tasks WHERE id = $1", task_id)
    history = await pool.fetch("SELECT * FROM task_outcome_reports ORDER BY id")
    mcp = FastMCP(name="grooming-schema-upgrade")
    register_task_tools(mcp)
    with (
        patch("bot_memory_server.tools.tasks.get_pool", return_value=pool),
        patch("bot_memory_server.tools.tasks.bus.publish", new_callable=AsyncMock),
    ):
        for _ in range(2):
            await pool.execute(SCHEMA_PATH.read_text())
            assert await pool.fetchrow("SELECT * FROM tasks WHERE id = $1", task_id) == before
        async with Client(mcp) as client:
            for _ in range(2):
                await client.call_tool(
                    "task_update",
                    {
                        "external_key": "UPGRADE-1",
                        "source_type": "manual",
                        "category": "grooming",
                    },
                )
                assert dict(await pool.fetchrow("SELECT * FROM tasks WHERE id = $1", task_id)) == {
                    **dict(before),
                    "category": "grooming",
                }
            # Reinstallation also succeeds with grooming rows already present.
            await pool.execute(SCHEMA_PATH.read_text())
            added = await client.call_tool(
                "task_add",
                {
                    "external_key": "GROOM-NEW",
                    "source_type": "manual",
                    "repo": "org/service",
                    "branch": "",
                    "category": "grooming",
                },
            )
            assert not added.is_error
    assert await pool.fetch("SELECT * FROM task_outcome_reports ORDER BY id") == history
    assert await pool.fetchval("SELECT category FROM tasks WHERE external_key = 'UPGRADE-WATCH'") == "monitoring"
    assert (
        await pool.fetchval(
            "INSERT INTO tasks (external_key, source_type) VALUES ('DEFAULT-1', 'manual') RETURNING category"
        )
        == "delivery"
    )
    with pytest.raises(asyncpg.CheckViolationError):
        async with pool.conn.transaction():
            await pool.execute(
                "INSERT INTO tasks (external_key, source_type, category) VALUES ('INVALID-1', 'manual', 'unknown')"
            )


@pytest.mark.asyncio
async def test_reported_target_wins_and_history_snapshot_stays_stable_real_database(repository_db):
    pool = repository_db
    url = "https://github.com/inferred/app/pull/1"
    stored = [{"type": "github_pr", "url": url}]
    metadata = {"prs": [{"url": url, "baseRepo": "legacy/app"}]}
    task_id = await pool.fetchval(
        "INSERT INTO tasks (external_key, source_type, status, artifacts, metadata) "
        "VALUES ('SNAPSHOT-1', 'manual', 'done', $1::jsonb, $2::jsonb) RETURNING id",
        json.dumps(stored),
        json.dumps(metadata),
    )
    mcp = FastMCP(name="repository-snapshot")
    register_task_tools(mcp)
    tools = {tool.name: tool.fn for tool in await mcp.list_tools()}
    evidence = [
        OutcomeEvidence(
            source="manual",
            reference="SNAPSHOT-1",
            resolution="accepted",
            disposition="Delivered",
            reason="Verified delivery",
        )
    ]
    with (
        patch("bot_memory_server.tools.tasks.get_pool", return_value=pool),
        patch("bot_memory_server.task_outcomes.get_pool", return_value=pool),
        patch("bot_memory_server.tools.tasks.bus.publish", new_callable=AsyncMock),
    ):
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            assert (await client.get("/tasks")).json()["items"][0]["canonicalRepositories"] == ["legacy/app"]
            first = await tools["task_outcome_report"](
                external_key="SNAPSHOT-1",
                source_type="manual",
                artifacts=[OutcomeArtifact(type="github_pr", url=url, targetProject="verified/app")],
                evidence=evidence,
                notes=None,
            )
            assert first["outcome"]["canonicalRepositories"] == ["verified/app"]
            await tools["task_remove"](external_key="SNAPSHOT-1", source_type="manual")
            original = await pool.fetchrow("SELECT * FROM task_outcome_reports WHERE id = $1", first["outcome"]["id"])
            assert (await client.get("/tasks", params={"repo": "verified/app"})).json()["total"] == 1
            assert (await client.get("/tasks", params={"repo": "inferred/app"})).json()["total"] == 0
            second = await tools["task_outcome_report"](
                external_key="SNAPSHOT-1",
                source_type="manual",
                artifacts=[OutcomeArtifact(type="github_pr", url=url, canonical_repo="corrected/app")],
                evidence=evidence,
                notes=None,
                correction=True,
            )
            assert second["outcome"]["canonicalRepositories"] == ["corrected/app"]
            # Later task changes and corrections must never recompute old snapshots.
            await pool.execute(
                "UPDATE tasks SET metadata = $1::jsonb WHERE id = $2",
                json.dumps({"prs": [{"url": url, "baseRepo": "changed/app"}]}),
                task_id,
            )
            assert await pool.fetchrow("SELECT * FROM task_outcome_reports WHERE id = $1", original["id"]) == original
            listing = (await client.get("/tasks")).json()
            assert listing["items"][0]["canonicalRepositories"] == ["corrected/app"]
            summary = (await client.get("/summary")).json()
            assert [(row["repo"], row["taskCount"]) for row in summary["repositories"]] == [("corrected/app", 1)]
