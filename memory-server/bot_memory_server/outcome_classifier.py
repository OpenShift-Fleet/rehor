"""Small evidence reducer: rejected > unknown > accepted/no-op."""

from __future__ import annotations

EVIDENCE_RESOLUTIONS = {"accepted", "rejected", "unknown"}


def _artifact_ref(artifact: dict) -> str:
    value = artifact.get("url") or artifact.get("id")
    return value or ""


def _superseded_refs(artifacts: list[dict]) -> set[str]:
    aliases: dict[str, set[str]] = {}
    for artifact in artifacts:
        references = {value for key in ("id", "url") if (value := artifact.get(key))}
        for reference in references:
            aliases.setdefault(reference, set()).update(references)

    superseded: set[str] = set()
    pending = [reference for artifact in artifacts for reference in artifact.get("supersedes", [])]
    while pending:
        reference = pending.pop()
        if reference in superseded:
            continue
        superseded.add(reference)
        pending.extend(aliases.get(reference, ()))
    return superseded


def _artifacts_with_states(artifacts: list[dict], superseded: set[str]) -> list[dict]:
    result = []
    for artifact in artifacts:
        value = dict(artifact)
        if _artifact_ref(value) in superseded:
            value["artifactState"] = "obsolete"
        result.append(value)
    return result


def _matches_task_reference(reference: str | None, task_reference: str) -> bool:
    if not reference:
        return False
    return reference.rstrip("/") == task_reference.rstrip("/") or reference.rstrip("/").endswith(f"/{task_reference}")


def classify_task_outcome(*, artifacts: list[dict], evidence: list[dict], task_reference: str) -> dict:
    """Reduce LLM-tagged evidence; agent does not submit final decision/confidence."""
    superseded = _superseded_refs(artifacts)
    artifacts_with_states = _artifacts_with_states(artifacts, superseded)
    relevant = []
    task_source_obsolete = False

    for item in evidence:
        reference = item.get("reference")
        if reference in superseded:
            continue
        if item.get("authorType") not in {None, "human", "workflow"}:
            continue

        resolution = item.get("resolution")
        if resolution not in EVIDENCE_RESOLUTIONS:
            raise ValueError("evidence resolution must be accepted, rejected, or unknown")
        relevant.append((resolution, item))

        if str(item.get("disposition", "")).casefold().strip() == "obsolete" and _matches_task_reference(
            reference, task_reference
        ):
            task_source_obsolete = True

    resolutions = [resolution for resolution, _ in relevant]
    if task_source_obsolete:
        decision = "obsolete"
        reason = next(
            (
                item["reason"]
                for _, item in relevant
                if str(item.get("disposition", "")).casefold().strip() == "obsolete"
                and _matches_task_reference(item.get("reference"), task_reference)
                and item.get("reason")
            ),
            "task source marks obsolete",
        )
    elif "rejected" in resolutions:
        decision = "rejected"
        reason = next(
            (item["reason"] for resolution, item in relevant if resolution == "rejected" and item.get("reason")),
            "rejected evidence",
        )
    elif "unknown" in resolutions:
        decision = "inconclusive"
        reason = next(
            (item["reason"] for resolution, item in relevant if resolution == "unknown" and item.get("reason")),
            "unclear evidence",
        )
    elif resolutions and all(value == "accepted" for value in resolutions):
        decision = "accepted"
        reason = next((item["reason"] for _, item in relevant if item.get("reason")), "accepted evidence")
    else:
        decision, reason = "inconclusive", "insufficient_evidence"

    return {
        "decision": decision,
        "confidence": "inconclusive" if decision == "inconclusive" else "conclusive",
        "reason": reason,
        "artifacts": artifacts_with_states,
    }
