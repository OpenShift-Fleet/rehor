"""Evidence category separates provider facts from comment author authority."""

from pathlib import Path

import pytest
import yaml
from bot_memory_server.models import OutcomeEvidence
from bot_memory_server.outcome_classifier import classify_task_outcome
from bot_memory_server.tools.tasks import register_task_tools
from fastmcp import Client, FastMCP
from pydantic import ValidationError


def _evidence(**overrides):
    return {
        "source": "GitHub",
        "reference": "https://github.com/acme/app/pull/551",
        "resolution": "accepted",
        "disposition": "MERGED",
        "reason": "Merged in target repository",
        **overrides,
    }


def _classify(*evidence, artifacts=None):
    return classify_task_outcome(artifacts=artifacts or [], evidence=list(evidence), task_reference="TASK-1")


@pytest.mark.parametrize("author_type", ["agent", "automation"])
@pytest.mark.parametrize("source", ["GitHub", "Custom provider"])
def test_automation_authored_merged_state_is_accepted(author_type, source):
    evidence = _evidence(kind="state", authorType=author_type, source=source)
    validated = OutcomeEvidence.model_validate(evidence).model_dump(by_alias=True)
    for item in (evidence, validated):
        outcome = _classify(item)
        assert outcome["decision"] == "accepted"
        assert outcome["confidence"] == "conclusive"
        assert outcome["reason"] == "Merged in target repository"


@pytest.mark.parametrize("author_type", ["agent", "automation"])
@pytest.mark.parametrize("resolution", ["accepted", "rejected", "unknown"])
def test_bot_comments_are_ignored_and_accepted_state_remains_accepted(author_type, resolution):
    comment = _evidence(
        kind="comment",
        authorType=author_type,
        resolution=resolution,
        disposition="Obsolete",
        reference="TASK-1",
        reason="Bot commentary must not decide the outcome",
    )
    assert _classify(comment)["decision"] == "inconclusive"
    outcome = _classify(_evidence(kind="state", authorType="automation"), comment)
    assert outcome["decision"] == "accepted"
    assert outcome["reason"] == "Merged in target repository"


@pytest.mark.parametrize("author_type", ["human", "workflow"])
def test_authoritative_comment_rejection_wins_over_accepted_state(author_type):
    outcome = _classify(
        _evidence(kind="state", authorType="automation"),
        _evidence(
            source="Custom review provider",
            kind="comment",
            authorType=author_type,
            resolution="rejected",
            disposition="Still required",
            reason="Reviewer rejected the result",
        ),
    )
    assert outcome["decision"] == "rejected"
    assert outcome["reason"] == "Reviewer rejected the result"


@pytest.mark.parametrize("author_type", [None, "human", "workflow", "agent", "automation"])
def test_absent_kind_legacy_facts_default_to_state(author_type):
    evidence = _evidence(authorType=author_type)
    model = OutcomeEvidence.model_validate(evidence)
    assert model.kind == "state"
    assert model.model_dump(by_alias=True)["kind"] == "state"
    assert _classify(evidence) == _classify(model.model_dump(by_alias=True))
    assert _classify(evidence)["decision"] == "accepted"


@pytest.mark.parametrize("author_fields", [{}, {"authorType": None}])
def test_comment_missing_author_preserves_authoritative_compatibility(author_fields):
    evidence = _evidence(kind="comment", **author_fields)
    assert _classify(evidence)["decision"] == "accepted"
    assert _classify(OutcomeEvidence.model_validate(evidence).model_dump(by_alias=True))["decision"] == "accepted"


def test_comment_unknown_author_is_not_authoritative_and_model_rejects_it():
    evidence = _evidence(kind="comment", authorType="unknown")
    assert _classify(evidence)["decision"] == "inconclusive"
    with pytest.raises(ValidationError, match="authorType"):
        OutcomeEvidence.model_validate(evidence)


@pytest.mark.parametrize("kind", ["provider", "COMMENT", "", None, 1])
def test_invalid_kind_fails_model_validation(kind):
    with pytest.raises(ValidationError, match="kind"):
        OutcomeEvidence.model_validate(_evidence(kind=kind))


def test_custom_state_uses_resolution_without_disposition_or_source_heuristics():
    outcome = _classify(
        _evidence(
            kind="state",
            source="Custom provider",
            authorType="agent",
            resolution="unknown",
            disposition="MERGED",
            reason="Provider has not confirmed acceptance",
        )
    )
    assert outcome["decision"] == "inconclusive"
    assert outcome["reason"] == "Provider has not confirmed acceptance"


def test_superseded_state_is_ignored_before_rejection_priority():
    artifacts = [
        {"type": "custom", "id": "old", "url": "https://example.test/old"},
        {"type": "custom", "id": "new", "supersedes": ["old"]},
    ]
    outcome = _classify(
        _evidence(kind="state", authorType="automation", reference="https://example.test/old", resolution="rejected"),
        _evidence(kind="state", authorType="agent", reference="new"),
        artifacts=artifacts,
    )
    assert outcome["decision"] == "accepted"
    assert outcome["artifacts"][0]["artifactState"] == "obsolete"


def test_task_obsolete_state_keeps_priority_over_authoritative_rejection():
    outcome = _classify(
        _evidence(kind="state", authorType="automation", reference="TASK-1", disposition="Obsolete"),
        _evidence(kind="comment", authorType="human", resolution="rejected"),
    )
    assert outcome["decision"] == "obsolete"


def test_openapi_evidence_kind_matches_model_contract():
    spec_path = Path(__file__).resolve().parents[2] / "shared" / "openapi.yaml"
    spec = yaml.safe_load(spec_path.read_text())
    schema = spec["components"]["schemas"]["OutcomeEvidence"]
    model_schema = OutcomeEvidence.model_json_schema(by_alias=True)
    for name in ("kind", "authorType"):
        assert schema["properties"][name]["description"] == model_schema["properties"][name]["description"]
    assert schema["properties"]["kind"]["enum"] == ["state", "comment"]
    assert schema["properties"]["kind"]["default"] == "state"
    assert "kind" not in schema["required"]
    assert schema["additionalProperties"] is False


@pytest.mark.asyncio
async def test_mcp_report_schema_exposes_optional_evidence_kind_and_author_docs():
    mcp = FastMCP(name="outcome-evidence-kind-schema")
    register_task_tools(mcp)
    async with Client(mcp) as client:
        tools = await client.list_tools()
    report = next(tool for tool in tools if tool.name == "task_outcome_report")
    schema = report.inputSchema["properties"]["evidence"]["items"]
    kind = schema["properties"]["kind"]
    assert kind["enum"] == ["state", "comment"]
    assert kind["default"] == "state"
    assert "kind" not in schema["required"]
    assert kind["description"] == OutcomeEvidence.model_json_schema()["properties"]["kind"]["description"]
    assert "State evidence is valid regardless of authorType" in schema["properties"]["authorType"]["description"]
