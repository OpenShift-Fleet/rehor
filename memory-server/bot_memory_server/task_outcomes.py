"""Task outcome persistence and read-only reporting API."""

import json
import re
from datetime import UTC, date, datetime, timedelta
from urllib.parse import unquote

from starlette.requests import Request
from starlette.responses import JSONResponse

from .db import get_pool
from .models import OutcomeArtifact, OutcomeEvidence
from .outcome_classifier import classify_task_outcome

_DECISION_FILTERS = {"accepted", "rejected", "obsolete", "inconclusive", "unreported", "wip"}
_CONFIDENCE_FILTERS = {"conclusive", "inconclusive"}
_MAX_LIMIT = 100
ARCHIVE_RECOVERY = (
    "Archive failed; ignore DONE. Call task_outcome_report for same task (artifacts,evidence,notes), "
    "then task_remove. Do not rerun skill; other steps may have completed."
)
ARCHIVE_EVIDENCE_GUIDANCE = (
    "Call task_outcome_report first: each evidence item needs source, reference, "
    "resolution: accepted|rejected|unknown, disposition, reason; then retry task_remove. "
    "Do not provide a final task decision. For an already archived task, set correction=true."
)


class TaskArchiveError(ValueError):
    """Archive failure with a recovery prefix safe for truncated legacy script output."""

    def __init__(self, detail: str, *, external_key: str, source_type: str | None, status_code: int = 409):
        self.payload = {
            "error": ARCHIVE_RECOVERY,
            "detail": detail,
            "evidence": ARCHIVE_EVIDENCE_GUIDANCE,
            "external_key": external_key,
            "source_type": source_type,
        }
        self.status_code = status_code
        super().__init__(f"{ARCHIVE_RECOVERY} {detail} {ARCHIVE_EVIDENCE_GUIDANCE}")


def _validated_archive_outcome(report, task) -> dict:
    """Validate selected report and serialize it before any lifecycle mutation."""
    if not report or report["id"] != task["outcome_report_id"] or report["task_id"] != task["id"]:
        raise ValueError("invalid staged outcome report identity")
    outcome = _outcome_from_row(report)
    if outcome["decision"] not in {"accepted", "rejected", "obsolete", "inconclusive"}:
        raise ValueError("invalid outcome decision")
    expected_confidence = "inconclusive" if outcome["decision"] == "inconclusive" else "conclusive"
    if (
        outcome["confidence"] != expected_confidence
        or not isinstance(outcome["reason"], str)
        or not outcome["reason"].strip()
    ):
        raise ValueError("invalid outcome confidence or reason")
    for field, model in (("artifacts", OutcomeArtifact), ("evidence", OutcomeEvidence)):
        # Inspect raw JSON too: null/object must not become an empty valid list.
        values = _json_value(report[field])
        if not isinstance(values, list):
            raise ValueError(f"invalid outcome {field}")
        for value in values:
            model.model_validate(value)
    repositories = _json_value(report["canonical_repositories"])
    if not isinstance(repositories, list) or any(not isinstance(repo, str) for repo in repositories):
        raise ValueError("invalid canonical repositories")
    json.dumps(outcome)
    return outcome


async def archive_task(pool, *, external_key: str, source_type: str | None = None, manual: bool = False):
    """Archive exactly one identity; strict retries preserve report/history/timestamps."""
    async with pool.acquire() as conn, conn.transaction():
        if source_type is None:
            matches = await conn.fetch(
                "SELECT * FROM tasks WHERE external_key = $1 ORDER BY id FOR UPDATE", external_key
            )
            if len(matches) > 1:
                raise TaskArchiveError(
                    "Ambiguous task key; specify source_type.", external_key=external_key, source_type=None
                )
            task = matches[0] if matches else None
        else:
            task = await conn.fetchrow(
                "SELECT * FROM tasks WHERE external_key = $1 AND source_type = $2 FOR UPDATE",
                external_key,
                source_type,
            )
        if not task:
            raise TaskArchiveError(
                f"Task {external_key} not found", external_key=external_key, source_type=source_type, status_code=404
            )
        outcome = None
        if not manual:
            if task["outcome_report_id"] is None:
                raise TaskArchiveError(
                    "Task requires task_outcome_report before archival.",
                    external_key=external_key,
                    source_type=task["source_type"],
                )
            report = await conn.fetchrow(
                "SELECT * FROM task_outcome_reports WHERE id = $1 AND task_id = $2",
                task["outcome_report_id"],
                task["id"],
            )
            try:
                outcome = _validated_archive_outcome(report, task)
            except (ValueError, TypeError, KeyError) as exc:
                raise TaskArchiveError(
                    "Task has an invalid staged outcome report; replace it with fresh evidence.",
                    external_key=external_key,
                    source_type=task["source_type"],
                ) from exc
            if task["status"] == "archived":
                return task, outcome, False
        clear_pointer = "outcome_report_id = NULL, " if manual else ""
        row = await conn.fetchrow(
            f"UPDATE tasks SET status = 'archived'::task_status, {clear_pointer}"
            "archived_at = CASE WHEN status = 'archived'::task_status THEN COALESCE(archived_at, NOW()) ELSE NOW() END "
            "WHERE id = $1 RETURNING *",
            task["id"],
        )
    return row, outcome, True


def _json_value(value):
    if isinstance(value, str):
        return json.loads(value)
    return value


_REPOSITORY_KEYS = (
    "baseRepo",
    "base_repo",
    "targetProject",
    "target_project",
    "targetRepo",
    "target_repo",
    "canonicalRepo",
    "canonical_repo",
)
_SOURCE_REPOSITORY_KEYS = (
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
)


def _normalize_repository(repository: str | None) -> str | None:
    """Keep in sync with outcome_normalize_repository in schema.sql."""
    if not isinstance(repository, str):
        return None
    repository = re.split(r"[?#]", repository, maxsplit=1)[0].strip().strip("/").strip()
    repository = repository.removesuffix(".git").strip().strip("/").strip()
    return repository or None


def canonical_repositories(task_repo: str | None, artifacts: list[dict]) -> list[str]:
    """Explicit target > decoded PR/MR URL > unambiguous legacy repo > task repo.

    A bare legacy repo is usable only without a head/source/fork marker. SQL's
    outcome_canonical_repositories implements the same ordered extraction.
    Duplicate URLs (or typed IDs without URLs) select the strongest candidate,
    with later inputs winning ties; unidentified artifacts remain independent.
    """
    selected = {}

    for position, artifact in enumerate(artifacts):
        if not isinstance(artifact, dict):
            continue
        repository = next(
            (normalized for key in _REPOSITORY_KEYS if (normalized := _normalize_repository(artifact.get(key)))),
            None,
        )
        rank = 0
        if not repository:
            repository = _repository_from_url(artifact.get("url"))
            rank = 1
        if not repository and not any(artifact.get(key) for key in _SOURCE_REPOSITORY_KEYS):
            repository = _normalize_repository(artifact.get("repo"))
            rank = 2
        if repository:
            url = artifact.get("url")
            artifact_type = artifact.get("type")
            artifact_id = artifact.get("id")
            if isinstance(url, str) and url.strip():
                identity = ("url", url.strip())
            elif (
                isinstance(artifact_type, str)
                and artifact_type.strip()
                and isinstance(artifact_id, str)
                and artifact_id.strip()
            ):
                identity = ("id", artifact_type.strip(), artifact_id.strip())
            else:
                identity = ("position", position)
            previous = selected.get(identity)
            if previous is None or rank <= previous[0]:
                selected[identity] = (rank, repository)

    seen = {repository for _, repository in selected.values()}
    if not seen:
        task_repo = _normalize_repository(task_repo)
        if task_repo:
            seen.add(task_repo)
    return sorted(seen)


def _repository_from_url(url: str | None) -> str | None:
    if not isinstance(url, str) or not url:
        return None
    path = re.split(r"[?#]", url.strip(), maxsplit=1)[0]
    path = re.sub(r"^[A-Za-z][A-Za-z0-9+.-]*://[^/]*", "", path)
    path = unquote(path).replace("\x00", "\ufffd").strip("/")
    if not path:
        return None

    gitlab_marker = re.search(r"/-/merge_requests/|/merge_requests/", path)
    if gitlab_marker:
        return _normalize_repository(path[: gitlab_marker.start()])

    segments = path.split("/")
    if len(segments) >= 4 and segments[2] in {"pull", "pulls"}:
        return _normalize_repository("/".join(segments[:2]))
    return None


def _outcome_report(
    *,
    decision: str,
    confidence: str,
    reason: str,
    reported_by: str,
    artifacts: list[dict],
    evidence: list[dict],
    canonical_repos: list[str],
    notes: str | None,
    run_id: str | None,
    reporting_cycle_id: int | None,
    attempt: int | None,
    workflow: str | None,
    instance_id: str | None,
    report_id: int | None = None,
    reported_at: datetime | str | None = None,
    verified_at: datetime | str | None = None,
) -> dict:
    def iso(value):
        return value.isoformat() if isinstance(value, datetime) else value

    result = {
        "decision": decision,
        "confidence": confidence,
        "reason": reason,
        "reportedBy": reported_by,
        "reportedAt": iso(reported_at),
        "verifiedAt": iso(verified_at),
        "artifacts": _json_value(artifacts) or [],
        "evidence": _json_value(evidence) or [],
        "canonicalRepositories": _json_value(canonical_repos) or [],
        "notes": notes,
        "runId": run_id,
        "reportingCycleId": reporting_cycle_id,
        "attempt": attempt,
        "workflow": workflow,
        "instanceId": instance_id,
    }
    if report_id is not None:
        result["id"] = report_id
    return result


async def record_task_outcome(
    conn,
    *,
    task_id: int,
    task_reference: str,
    task_repo: str | None,
    artifacts: list[dict],
    evidence: list[dict],
    notes: str | None = None,
    verified_at: datetime | None = None,
    run_id: str | None = None,
    reporting_cycle_id: int | None = None,
    attempt: int | None = None,
    workflow: str | None = None,
    instance_id: str | None = None,
    reported_by: str = "agent",
) -> dict:
    outcome = classify_task_outcome(
        artifacts=artifacts,
        evidence=evidence,
        task_reference=task_reference,
    )
    artifacts = outcome["artifacts"]
    decision = outcome["decision"]
    confidence = outcome["confidence"]
    reason = outcome["reason"]

    # PostgreSQL's BEFORE INSERT trigger also includes persisted task artifacts
    # and raw metadata.prs, without changing artifact extras or this bind contract.
    report = await conn.fetchrow(
        """
        INSERT INTO task_outcome_reports (
            task_id, decision, confidence, reason, reported_by, verified_at,
            artifacts, evidence, canonical_repositories, notes, run_id,
            reporting_cycle_id, attempt, workflow, instance_id
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb,
                $10, $11, $12, $13, $14, $15)
        RETURNING *
        """,
        task_id,
        decision,
        confidence,
        reason.strip(),
        reported_by,
        verified_at,
        json.dumps(artifacts),
        json.dumps(evidence),
        json.dumps(canonical_repositories(task_repo, artifacts)),
        notes,
        run_id,
        reporting_cycle_id,
        attempt,
        workflow,
        instance_id,
    )
    return _outcome_from_row(report)


def _outcome_from_row(row) -> dict:
    return _outcome_report(
        report_id=row["id"],
        decision=row["decision"],
        confidence=row["confidence"],
        reason=row["reason"],
        reported_by=row["reported_by"],
        reported_at=row["reported_at"],
        verified_at=row["verified_at"],
        artifacts=row["artifacts"],
        evidence=row["evidence"],
        canonical_repos=row["canonical_repositories"],
        notes=row["notes"],
        run_id=row["run_id"],
        reporting_cycle_id=row["reporting_cycle_id"],
        attempt=row["attempt"],
        workflow=row["workflow"],
        instance_id=row["instance_id"],
    )


_TASK_OUTCOMES_CTE = """
WITH task_outcomes AS (
    SELECT
        t.id AS task_id,
        t.external_key,
        t.source_type,
        t.source_url,
        t.status::text AS task_status,
        t.repo,
        t.title,
        t.summary,
        t.created_at,
        t.last_addressed,
        t.archived_at,
        COALESCE(t.artifacts, '[]'::jsonb) AS task_artifacts,
        o.id AS outcome_id,
        o.decision,
        o.confidence,
        o.reason,
        o.reported_by,
        o.reported_at,
        o.verified_at,
        o.artifacts AS outcome_artifacts,
        o.evidence,
        COALESCE(o.canonical_repositories, outcome_canonical_repositories(
            t.repo, COALESCE(t.artifacts, '[]'::jsonb) ||
            CASE WHEN jsonb_typeof(t.metadata->'prs') = 'array'
                 THEN t.metadata->'prs' ELSE '[]'::jsonb END
        )) AS canonical_repositories,
        o.notes,
        o.run_id,
        o.reporting_cycle_id,
        o.attempt,
        o.workflow,
        COALESCE(o.instance_id, t.instance_id) AS instance_id,
        CASE
            WHEN t.status::text = ANY(ARRAY['in_progress', 'pr_open', 'pr_changes', 'paused']) THEN 'wip'
            WHEN t.status::text IN ('archived', 'done') AND o.id IS NOT NULL
                AND (o.confidence = 'inconclusive' OR o.decision = 'inconclusive') THEN 'inconclusive'
            WHEN t.status::text IN ('archived', 'done') AND o.id IS NOT NULL AND o.decision = 'obsolete' THEN 'obsolete'
            WHEN t.status::text IN ('archived', 'done') AND o.id IS NOT NULL THEN o.decision
            ELSE 'unreported'
        END AS state,
        COALESCE(o.reported_at,
            CASE WHEN t.status::text = 'archived' THEN t.archived_at END,
            t.last_addressed,
            t.created_at
        ) AS event_at
    FROM tasks t
    LEFT JOIN task_outcome_reports o
        ON o.id = t.outcome_report_id
        AND o.task_id = t.id
        AND t.status::text IN ('archived', 'done')
)
"""


def _filtered_cte(request: Request) -> tuple[str, list]:
    params = []
    conditions = []

    def add(value, expression):
        params.append(value)
        conditions.append(expression.format(index=len(params)))

    repo = request.query_params.get("repo")
    if repo:
        add(repo, "canonical_repositories ? ${index}")

    state = request.query_params.get("decision")
    if state:
        if state not in _DECISION_FILTERS:
            raise ValueError("decision must be accepted, rejected, obsolete, inconclusive, unreported, or wip")
        add(state, "state = ${index}")

    confidence = request.query_params.get("confidence")
    if confidence:
        if confidence not in _CONFIDENCE_FILTERS:
            raise ValueError("confidence must be conclusive or inconclusive")
        add(confidence, "confidence = ${index}")

    reason = request.query_params.get("reason")
    if reason:
        add(reason, "reason = ${index}")

    source = request.query_params.get("source")
    if source:
        add(
            source.casefold(),
            "EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(evidence, '[]'::jsonb)) AS evidence_item(value) "
            "WHERE lower(evidence_item.value->>'source') = ${index})",
        )

    from_date = _parse_date(request.query_params.get("from"), "from")
    to_date = _parse_date(request.query_params.get("to"), "to")
    if from_date and to_date and from_date > to_date:
        raise ValueError("from must be on or before to")
    if from_date:
        add(from_date, "event_at >= (${index}::date::timestamp AT TIME ZONE 'UTC')")
    if to_date:
        add(to_date + timedelta(days=1), "event_at < (${index}::date::timestamp AT TIME ZONE 'UTC')")

    where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
    return f"{_TASK_OUTCOMES_CTE}, filtered AS (SELECT * FROM task_outcomes {where})", params


def _parse_date(value: str | None, name: str) -> date | None:
    if value is None:
        return None
    try:
        return date.fromisoformat(value)
    except ValueError as exc:
        raise ValueError(f"{name} must use YYYY-MM-DD format") from exc


def _parse_pagination(request: Request) -> tuple[int, int]:
    try:
        limit = int(request.query_params.get("limit", "50"))
        offset = int(request.query_params.get("offset", "0"))
    except ValueError as exc:
        raise ValueError("limit and offset must be integers") from exc
    if not 1 <= limit <= _MAX_LIMIT:
        raise ValueError(f"limit must be between 1 and {_MAX_LIMIT}")
    if offset < 0:
        raise ValueError("offset must be zero or greater")
    return limit, offset


def _timestamp(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


def _serialize_task(
    row,
    *,
    history: list[dict] | None = None,
    task_cycles: list[dict] | None = None,
) -> dict:
    artifacts = _json_value(row["outcome_artifacts"] if row["outcome_id"] is not None else row["task_artifacts"]) or []
    evidence = _json_value(row["evidence"]) or []
    repositories = _json_value(row["canonical_repositories"]) or []
    outcome = None
    if row["outcome_id"] is not None:
        outcome = _outcome_report(
            report_id=row["outcome_id"],
            decision=row["decision"],
            confidence=row["confidence"],
            reason=row["reason"],
            reported_by=row["reported_by"],
            reported_at=row["reported_at"],
            verified_at=row["verified_at"],
            artifacts=artifacts,
            evidence=evidence,
            canonical_repos=repositories,
            notes=row["notes"],
            run_id=row["run_id"],
            reporting_cycle_id=row["reporting_cycle_id"],
            attempt=row["attempt"],
            workflow=row["workflow"],
            instance_id=row["instance_id"],
        )

    task = {
        "taskId": row["task_id"],
        "externalKey": row["external_key"],
        "sourceType": row["source_type"],
        "sourceUrl": row["source_url"],
        "lifecycle": {
            "status": row["task_status"],
            "createdAt": _timestamp(row["created_at"]),
            "lastAddressed": _timestamp(row["last_addressed"]),
            "archivedAt": _timestamp(row["archived_at"]),
        },
        "state": row["state"],
        "repo": row["repo"],
        "canonicalRepositories": repositories,
        "title": row["title"],
        "summary": row["summary"],
        "outcome": outcome,
        "artifacts": artifacts,
        "evidence": evidence,
        "timestamps": {
            "createdAt": _timestamp(row["created_at"]),
            "lastAddressed": _timestamp(row["last_addressed"]),
            "archivedAt": _timestamp(row["archived_at"]),
            "reportedAt": _timestamp(row["reported_at"]),
            "verifiedAt": _timestamp(row["verified_at"]),
        },
    }
    if history is not None:
        task["outcomeHistory"] = history
    if task_cycles is not None:
        task["taskCycles"] = task_cycles
    return task


async def api_task_outcomes_summary(request: Request) -> JSONResponse:
    try:
        cte, params = _filtered_cte(request)
    except ValueError as exc:
        return JSONResponse({"error": str(exc)}, status_code=400)

    pool = get_pool()
    counts = await pool.fetchrow(
        f"""{cte}
        SELECT COUNT(*) AS task_count,
            COUNT(*) FILTER (WHERE state = 'accepted') AS accepted_count,
            COUNT(*) FILTER (WHERE state = 'rejected') AS rejected_count,
            COUNT(*) FILTER (WHERE state = 'obsolete') AS obsolete_count,
            COUNT(*) FILTER (WHERE state = 'inconclusive') AS inconclusive_count,
            COUNT(*) FILTER (WHERE state = 'unreported') AS unreported_count,
            COUNT(*) FILTER (WHERE state = 'wip') AS wip_count
        FROM filtered""",
        *params,
    )
    repository_count = await pool.fetchval(
        f"""{cte}
        SELECT COUNT(DISTINCT repositories.repo)
        FROM filtered f
        CROSS JOIN LATERAL jsonb_array_elements_text(f.canonical_repositories) AS repositories(repo)""",
        *params,
    )
    repository_rows = await pool.fetch(
        f"""{cte}
        SELECT repositories.repo,
            COUNT(DISTINCT f.task_id) AS task_count,
            COUNT(DISTINCT f.task_id) FILTER (WHERE f.state = 'accepted') AS accepted_count,
            COUNT(DISTINCT f.task_id) FILTER (WHERE f.state = 'rejected') AS rejected_count,
            COUNT(DISTINCT f.task_id) FILTER (WHERE f.state = 'obsolete') AS obsolete_count,
            COUNT(DISTINCT f.task_id) FILTER (WHERE f.state = 'inconclusive') AS inconclusive_count,
            COUNT(DISTINCT f.task_id) FILTER (WHERE f.state = 'unreported') AS unreported_count,
            COUNT(DISTINCT f.task_id) FILTER (WHERE f.state = 'wip') AS wip_count
        FROM filtered f
        CROSS JOIN LATERAL jsonb_array_elements_text(f.canonical_repositories) AS repositories(repo)
        GROUP BY repositories.repo
        ORDER BY task_count DESC, repositories.repo""",
        *params,
    )
    reason_rows = await pool.fetch(
        f"""{cte}
        SELECT repositories.repo, f.reason, COUNT(DISTINCT f.task_id) AS task_count
        FROM filtered f
        CROSS JOIN LATERAL jsonb_array_elements_text(f.canonical_repositories) AS repositories(repo)
        WHERE f.reason IS NOT NULL AND f.state IN ('accepted', 'rejected', 'obsolete', 'inconclusive')
        GROUP BY repositories.repo, f.reason""",
        *params,
    )
    provider_rows = await pool.fetch(
        f"""{cte}
        SELECT repositories.repo, lower(evidence_item.value->>'source') AS source,
            COUNT(DISTINCT f.task_id) AS task_count
        FROM filtered f
        CROSS JOIN LATERAL jsonb_array_elements_text(f.canonical_repositories) AS repositories(repo)
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(f.evidence, '[]'::jsonb)) AS evidence_item(value)
        WHERE evidence_item.value->>'source' IS NOT NULL
        GROUP BY repositories.repo, lower(evidence_item.value->>'source')""",
        *params,
    )

    reasons_by_repo: dict[str, dict[str, int]] = {}
    for row in reason_rows:
        reasons_by_repo.setdefault(row["repo"], {})[row["reason"]] = row["task_count"]
    providers_by_repo: dict[str, dict[str, int]] = {}
    for row in provider_rows:
        providers_by_repo.setdefault(row["repo"], {})[row["source"]] = row["task_count"]

    def acceptance_rate(accepted: int, rejected: int) -> float | None:
        denominator = accepted + rejected
        return accepted / denominator if denominator else None

    repositories = []
    for row in repository_rows:
        accepted = row["accepted_count"]
        rejected = row["rejected_count"]
        repositories.append(
            {
                "repo": row["repo"],
                "acceptanceRate": acceptance_rate(accepted, rejected),
                "taskCount": row["task_count"],
                "acceptedCount": accepted,
                "rejectedCount": rejected,
                "obsoleteCount": row["obsolete_count"],
                "inconclusiveCount": row["inconclusive_count"],
                "unreportedCount": row["unreported_count"],
                "wipCount": row["wip_count"],
                "reasons": reasons_by_repo.get(row["repo"], {}),
                "providers": providers_by_repo.get(row["repo"], {}),
            }
        )

    accepted = counts["accepted_count"]
    rejected = counts["rejected_count"]
    from_value = request.query_params.get("from")
    to_value = request.query_params.get("to")
    return JSONResponse(
        {
            "period": {"from": from_value, "to": to_value},
            "summary": {
                "acceptanceRate": acceptance_rate(accepted, rejected),
                "taskCount": counts["task_count"],
                "repositoryCount": repository_count,
                "acceptedCount": accepted,
                "rejectedCount": rejected,
                "obsoleteCount": counts["obsolete_count"],
                "inconclusiveCount": counts["inconclusive_count"],
                "unreportedCount": counts["unreported_count"],
                "wipCount": counts["wip_count"],
            },
            "repositories": repositories,
            "freshness": {"generatedAt": datetime.now(UTC).isoformat()},
            "backfill": {"state": "not_started", "unknownCount": counts["unreported_count"]},
        }
    )


async def api_task_outcomes(request: Request) -> JSONResponse:
    try:
        cte, params = _filtered_cte(request)
        limit, offset = _parse_pagination(request)
    except ValueError as exc:
        return JSONResponse({"error": str(exc)}, status_code=400)

    pool = get_pool()
    total = await pool.fetchval(f"{cte} SELECT COUNT(*) FROM filtered", *params)
    rows = await pool.fetch(
        f"""{cte}
        SELECT * FROM filtered
        ORDER BY event_at DESC, task_id DESC
        LIMIT ${len(params) + 1} OFFSET ${len(params) + 2}""",
        *params,
        limit,
        offset,
    )
    return JSONResponse(
        {
            "items": [_serialize_task(row) for row in rows],
            "total": total,
            "limit": limit,
            "offset": offset,
        }
    )


async def api_task_outcome_detail(request: Request) -> JSONResponse:
    try:
        task_id = int(request.path_params.get("task_id", ""))
    except ValueError:
        return JSONResponse({"error": "task_id must be an integer"}, status_code=400)

    pool = get_pool()
    rows = await pool.fetch(
        f"{_TASK_OUTCOMES_CTE} SELECT * FROM task_outcomes WHERE task_id = $1",
        task_id,
    )
    if not rows:
        return JSONResponse({"error": f"Task {task_id} not found"}, status_code=404)

    report_rows = await pool.fetch(
        "SELECT * FROM task_outcome_reports WHERE task_id = $1 ORDER BY id",
        task_id,
    )
    history = [_outcome_from_row(row) for row in report_rows]
    cycle_rows = await pool.fetch(
        """
        SELECT id, cycle_type, instance_id, started_at, finished_at
        FROM cycle_runs
        WHERE task_id = $1
        ORDER BY started_at, id
        """,
        task_id,
    )
    task_cycles = [
        {
            "id": row["id"],
            "cycleType": row["cycle_type"],
            "instanceId": row["instance_id"],
            "startedAt": _timestamp(row["started_at"]),
            "finishedAt": _timestamp(row["finished_at"]),
        }
        for row in cycle_rows
    ]
    return JSONResponse(_serialize_task(rows[0], history=history, task_cycles=task_cycles))
