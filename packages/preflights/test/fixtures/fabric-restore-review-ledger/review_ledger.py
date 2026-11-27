#!/usr/bin/env python3
"""Encode and restore the public-safe review ledger from the GitHub summary."""

from __future__ import annotations

import base64
import json
import re
import subprocess
import zlib
from pathlib import Path
from uuid import uuid4

from public_comment_safety import ensure_public_content


MARKER_RE = re.compile(r"<!-- dev-review-bot:review-ledger:v1:([A-Za-z0-9_-]+) -->")
RISK_MARKER_RE = re.compile(r"<!-- dev-review-bot:risk-assessment:v1:([A-Za-z0-9_-]+) -->")
REVISION_RE = re.compile(r"<!-- dev-review-bot:fabric-access-review:([0-9a-f]{40}):([0-9a-f]{40}) -->")
REVIEW_NUMBER_RE = re.compile(r"(?m)^## Review ([1-9]\d*)$")
STATUS_SUMMARY_RE = re.compile(r"(?m)^## Review [1-9]\d*\r?\n\r?\n([^\r\n]+)")
FINDING_ID_RE = re.compile(r"F[1-9]\d*")
REFERENCE_ID_RE = re.compile(r"R[1-9]\d*")
SHA_RE = re.compile(r"[0-9a-f]{40}")
MAX_MARKER_LENGTH = 48_000
MAX_DECOMPRESSED_BYTES = 1_000_000


class LedgerError(ValueError):
    """The review ledger is malformed or cannot be restored safely."""


class LedgerPayloadMissing(LedgerError):
    """The tracked review predates durable ledger payloads."""


class EmptyPendingReview(LedgerPayloadMissing):
    """A bot-owned pending review is empty and can safely receive a fresh summary."""

    def __init__(self, message: str, *, reusable: bool = True):
        super().__init__(message)
        self.reusable = reusable


def _text(value: object, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise LedgerError(f"{field} must be non-empty text")
    return value.strip()


def _sha(value: object, field: str, *, optional: bool = False) -> str | None:
    if optional and value is None:
        return None
    if not isinstance(value, str) or not SHA_RE.fullmatch(value):
        raise LedgerError(f"{field} must be a 40-character commit SHA")
    return value


def _reference(value: object, field: str) -> dict:
    if not isinstance(value, dict):
        raise LedgerError(f"{field} must be an object")
    result = {}
    if "id" in value:
        ident = _text(value["id"], f"{field}.id")
        if not REFERENCE_ID_RE.fullmatch(ident):
            raise LedgerError(f"{field}.id is invalid")
        result["id"] = ident
    result["repo"] = _text(value.get("repo"), f"{field}.repo")
    result["sha"] = _sha(value.get("sha"), f"{field}.sha")
    result["file"] = _text(value.get("file"), f"{field}.file")
    line = value.get("line")
    if not isinstance(line, int) or isinstance(line, bool) or line < 1:
        raise LedgerError(f"{field}.line must be a positive integer")
    result["line"] = line
    url = value.get("url")
    if url is not None:
        url = _text(url, f"{field}.url")
        if not url.startswith("https://github.com/"):
            raise LedgerError(f"{field}.url must be a GitHub URL")
        result["url"] = url
    return result


def public_ledger(ledger: object) -> list[dict]:
    """Keep only resume data already represented in public review comments.

    Raw source lines and status-evidence prose are omitted. Rejected entries
    retain their verifier reason because it appears in the public status table.
    Addressed and rejected entries become tombstones so IDs are never reused.
    """
    if not isinstance(ledger, list):
        raise LedgerError("Ledger must be an array")
    output = []
    seen: set[str] = set()
    for index, entry in enumerate(ledger):
        field = f"ledger[{index}]"
        if not isinstance(entry, dict):
            raise LedgerError(f"{field} must be an object")
        ident = _text(entry.get("id"), f"{field}.id")
        if not FINDING_ID_RE.fullmatch(ident) or ident in seen:
            raise LedgerError(f"{field}.id must be unique and use F1, F2, ... format")
        seen.add(ident)
        status = entry.get("status", "open")
        if not isinstance(status, str) or status not in {"open", "addressed", "rejected"}:
            raise LedgerError(f"{field}.status must be open, addressed, or rejected")
        severity = entry.get("severity") or "not recorded"
        if not isinstance(severity, str) or not severity.strip():
            raise LedgerError(f"{field}.severity must be text")
        dimensions = entry.get("source_dimensions") or []
        if (not isinstance(dimensions, list)
                or any(not isinstance(name, str) or not name.strip() for name in dimensions)):
            raise LedgerError(f"{field}.source_dimensions must be an array of names")

        public = {
            "id": ident,
            "status": status,
            "severity": severity.strip(),
            "source_dimensions": list(dict.fromkeys(name.strip() for name in dimensions)),
        }
        category = entry.get("category")
        if isinstance(category, str) and category.strip():
            public["category"] = category.strip()
        for key in ("first_flagged_sha", "last_checked_sha"):
            if key in entry:
                public[key] = _sha(entry[key], f"{field}.{key}")
        if status == "rejected":
            note = _text(entry.get("status_note"), f"{field}.status_note")
            public["status_note"] = note

        ensure_public_content(json.dumps(public, ensure_ascii=False), f"Ledger finding {ident}")
        if status in {"addressed", "rejected"}:
            output.append(public)
            continue

        location = entry.get("location")
        if not isinstance(location, dict):
            raise LedgerError(f"{field}.location must be an object")
        side = location.get("side")
        if not isinstance(side, str) or side not in {"added", "removed"}:
            raise LedgerError(f"{field}.location.side must be added or removed")
        line = location.get("line")
        if not isinstance(line, int) or isinstance(line, bool) or line < 1:
            raise LedgerError(f"{field}.location.line must be a positive integer")
        public["location"] = {
            "repo": _text(location.get("repo"), f"{field}.location.repo"),
            "file": _text(location.get("file"), f"{field}.location.file"),
            "line": line,
            "side": side,
        }
        for key in ("claim", "trigger", "impact", "suggested_fix"):
            public[key] = _text(entry.get(key), f"{field}.{key}")
        for key in ("expected_result", "actual_result"):
            if key in entry:
                public[key] = _text(entry.get(key), f"{field}.{key}")
        scenario = entry.get("scenario")
        if (not isinstance(scenario, list)
                or any(not isinstance(step, str) or not step.strip() for step in scenario)):
            raise LedgerError(f"{field}.scenario must be an array of text")
        public["scenario"] = [step.strip() for step in scenario]
        evidence = entry.get("evidence")
        if not isinstance(evidence, dict):
            raise LedgerError(f"{field}.evidence must be an object")
        public_refs = [_reference(ref, f"{field}.refs[{ref_index}]")
                       for ref_index, ref in enumerate(entry.get("refs", []))]
        evidence_refs = [_reference(ref, f"{field}.evidence.refs[{ref_index}]")
                         for ref_index, ref in enumerate(evidence.get("refs", []))]
        if public_refs != evidence_refs:
            raise LedgerError(f"{field}.refs and evidence.refs must match")
        public["refs"] = public_refs
        public["evidence"] = {
            "explanation": _text(evidence.get("explanation"), f"{field}.evidence.explanation"),
            "refs": evidence_refs,
        }
        ensure_public_content(json.dumps(public, ensure_ascii=False), f"Ledger finding {ident}")
        output.append(public)
    return output


def _encode_payload(repo: str, pr: int, head: str, base: str,
                    update_count: int, ledger: object) -> tuple[dict, str]:
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo):
        raise LedgerError("Repository must be owner/name")
    if not isinstance(pr, int) or isinstance(pr, bool) or pr < 1:
        raise LedgerError("PR number must be positive")
    _sha(head, "head_sha")
    _sha(base, "base_sha")
    if not isinstance(update_count, int) or isinstance(update_count, bool) or update_count < 0:
        raise LedgerError("Update count must be non-negative")
    payload = {
        "version": 1,
        "repo": repo,
        "pr": pr,
        "head_sha": head,
        "base_sha": base,
        "update_count": update_count,
        "findings": public_ledger(ledger),
    }
    raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    encoded = base64.urlsafe_b64encode(zlib.compress(raw, 9)).decode("ascii").rstrip("=")
    marker = f"<!-- dev-review-bot:review-ledger:v1:{encoded} -->"
    if len(marker) > MAX_MARKER_LENGTH:
        raise LedgerError("Public ledger payload is too large for a GitHub review comment")
    return payload, marker


def append_to_body(body: str, repo: str, pr: int, head: str, base: str,
                   update_count: int, ledger: object) -> str:
    """Append one compressed, versioned HTML-comment payload to a review body."""
    if not isinstance(body, str) or not body.strip():
        raise LedgerError("Review body is empty")
    ensure_public_content(body, "Status review")
    revision = REVISION_RE.findall(body)
    if revision != [(head, base)]:
        raise LedgerError("Review body must contain exactly one matching revision marker")
    number = REVIEW_NUMBER_RE.findall(body)
    if number != [str(update_count + 1)]:
        raise LedgerError("Review heading does not match the ledger update count")
    payload, marker = _encode_payload(repo, pr, head, base, update_count, ledger)
    existing = MARKER_RE.findall(body)
    prefix_count = body.count("<!-- dev-review-bot:review-ledger:v1:")
    if prefix_count != len(existing):
        raise LedgerError("Review body contains a malformed ledger payload marker")
    if existing:
        if len(existing) != 1:
            raise LedgerError("Review body contains multiple ledger payloads")
        restored = decode_body(body, repo, pr)
        if restored != payload:
            raise LedgerError("Review body already contains a different ledger payload")
        if len(body) > 60_000:
            raise LedgerError("Review body with ledger payload exceeds the safe size limit")
        return body
    result = body.rstrip() + "\n\n" + marker + "\n"
    if len(result) > 60_000:
        raise LedgerError("Review body with ledger payload exceeds the safe size limit")
    return result


def decode_body(body: object, repo: str, pr: int) -> dict:
    if not isinstance(body, str):
        raise LedgerError("GitHub review body is missing")
    if len(body) > 60_000:
        raise LedgerError("GitHub review body exceeds the safe size limit")
    matches = MARKER_RE.findall(body)
    if body.count("<!-- dev-review-bot:review-ledger:v1:") != len(matches):
        raise LedgerError("Tracked review contains a malformed ledger payload marker")
    if not matches:
        if "<!-- dev-review-bot:review-ledger:v1:" in body:
            raise LedgerError("Tracked review contains a malformed ledger payload marker")
        raise LedgerPayloadMissing("Tracked review has no embedded ledger payload")
    if len(matches) != 1:
        raise LedgerError("Tracked review contains multiple ledger payloads")
    encoded = matches[0]
    if len(encoded) > MAX_MARKER_LENGTH:
        raise LedgerError("Ledger payload exceeds the safe size limit")
    try:
        compressed = base64.urlsafe_b64decode(encoded + "=" * ((4 - len(encoded) % 4) % 4))
        decompressor = zlib.decompressobj()
        raw = decompressor.decompress(compressed, MAX_DECOMPRESSED_BYTES + 1)
        if len(raw) > MAX_DECOMPRESSED_BYTES or decompressor.unconsumed_tail:
            raise LedgerError("Decompressed ledger exceeds the safe size limit")
        raw += decompressor.flush()
        if len(raw) > MAX_DECOMPRESSED_BYTES or not decompressor.eof or decompressor.unused_data:
            raise LedgerError("Ledger payload compression is invalid")
        payload = json.loads(raw)
    except (ValueError, zlib.error, json.JSONDecodeError) as exc:
        if isinstance(exc, LedgerError):
            raise
        raise LedgerError("Ledger payload is not valid compressed JSON") from exc
    if (not isinstance(payload, dict) or payload.get("version") != 1
            or payload.get("repo") != repo or payload.get("pr") != pr):
        raise LedgerError("Ledger payload belongs to another schema, repository, or PR")
    head = _sha(payload.get("head_sha"), "head_sha")
    base = _sha(payload.get("base_sha"), "base_sha")
    update_count = payload.get("update_count")
    if not isinstance(update_count, int) or isinstance(update_count, bool) or update_count < 0:
        raise LedgerError("Ledger payload update_count is invalid")
    if REVISION_RE.findall(body) != [(head, base)]:
        raise LedgerError("Ledger SHAs do not match the status comment revision marker")
    if REVIEW_NUMBER_RE.findall(body) != [str(update_count + 1)]:
        raise LedgerError("Ledger update count does not match the status heading")
    ledger = public_ledger(payload.get("findings"))
    if ledger != payload.get("findings"):
        raise LedgerError("Ledger payload contains fields outside the public resume schema")
    return {**payload, "findings": ledger}


def status_summary(body: object) -> str | None:
    """Extract the one-line PR purpose sentence from a rendered status review."""
    if not isinstance(body, str):
        return None
    match = STATUS_SUMMARY_RE.search(body)
    if not match:
        return None
    summary = match.group(1).strip()
    return summary or None


def encode_risk_assessment(assessment: dict) -> str:
    """Encode the public risk decision with the exact PR revision it assessed."""
    level = assessment.get("risk")
    if not isinstance(level, str) or level not in {"low", "medium", "high"}:
        raise LedgerError("Risk assessment level is invalid")
    explanation = _text(assessment.get("explanation"), "risk_assessment.explanation")
    files = assessment.get("evidence_files")
    if (not isinstance(files, list) or not 1 <= len(files) <= 8
            or any(not isinstance(path, str) or not path.strip() for path in files)
            or len(files) != len(set(files))):
        raise LedgerError("Risk assessment evidence_files is invalid")
    head = _sha(assessment.get("head_sha"), "risk_assessment.head_sha")
    base = _sha(assessment.get("base_sha"), "risk_assessment.base_sha")
    payload = {
        "version": 1,
        "risk": level,
        "explanation": explanation,
        "evidence_files": [path.strip() for path in files],
        "head_sha": head,
        "base_sha": base,
    }
    ensure_public_content(json.dumps(payload, ensure_ascii=False), "Risk assessment")
    encoded = base64.urlsafe_b64encode(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    ).decode("ascii").rstrip("=")
    return f"<!-- dev-review-bot:risk-assessment:v1:{encoded} -->"


def risk_assessment_from_body(body: object) -> dict | None:
    """Restore an optional revision-bound risk assessment from a status review."""
    if not isinstance(body, str) or len(body) > 60_000:
        raise LedgerError("Status review body is invalid for risk restoration")
    matches = RISK_MARKER_RE.findall(body)
    marker_prefix = "<!-- dev-review-bot:risk-assessment:v1:"
    if body.count(marker_prefix) != len(matches):
        raise LedgerError("Status review has a malformed risk-assessment marker")
    if not matches:
        return None
    if len(matches) != 1 or len(matches[0]) > 12_000:
        raise LedgerError("Status review has multiple or oversized risk assessments")
    encoded = matches[0]
    try:
        raw = base64.b64decode(
            encoded + "=" * ((4 - len(encoded) % 4) % 4), altchars=b"-_", validate=True,
        )
        payload = json.loads(raw)
    except (ValueError, json.JSONDecodeError) as exc:
        raise LedgerError("Status review risk assessment is malformed") from exc
    if (not isinstance(payload, dict)
            or set(payload) != {"version", "risk", "explanation", "evidence_files", "head_sha", "base_sha"}
            or type(payload.get("version")) is not int or payload.get("version") != 1
            or not isinstance(payload.get("risk"), str)
            or payload.get("risk") not in {"low", "medium", "high"}):
        raise LedgerError("Status review risk assessment has an unsupported schema")
    explanation = _text(payload.get("explanation"), "risk_assessment.explanation")
    files = payload.get("evidence_files")
    if (not isinstance(files, list) or not 1 <= len(files) <= 8
            or any(not isinstance(path, str) or not path.strip() for path in files)
            or len(files) != len(set(files))):
        raise LedgerError("Status review risk assessment evidence_files is invalid")
    head = _sha(payload.get("head_sha"), "risk_assessment.head_sha")
    base = _sha(payload.get("base_sha"), "risk_assessment.base_sha")
    restored = {
        "risk": payload["risk"],
        "explanation": explanation,
        "evidence_files": [path.strip() for path in files],
        "head_sha": head,
        "base_sha": base,
    }
    ensure_public_content(json.dumps(restored, ensure_ascii=False), "Risk assessment")
    return restored


def restore_from_review(repo: str, pr: int, review_id: int, bot_login: str,
                        expected_head: str | None = None) -> dict:
    if (not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo)
            or not isinstance(pr, int) or isinstance(pr, bool) or pr < 1
            or not isinstance(review_id, int) or isinstance(review_id, bool) or review_id < 1):
        raise LedgerError("Repository, PR, or review ID is invalid")
    result = subprocess.run(
        ["gh", "api", f"repos/{repo}/pulls/{pr}/reviews/{review_id}"],
        capture_output=True, text=True, timeout=30, check=False,
    )
    if result.returncode:
        raise LedgerError(result.stderr.strip() or "Could not read the tracked GitHub review")
    try:
        review = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise LedgerError("GitHub returned invalid review data") from exc
    author = (review.get("user") or {}).get("login") if isinstance(review, dict) else None
    if not isinstance(author, str) or author.casefold() != bot_login.casefold():
        raise LedgerError("Tracked review was not authored by this bot account")
    if review.get("state") == "PENDING":
        if not isinstance(review.get("body"), str) or review["body"].strip():
            raise LedgerError("Tracked pending review has content and cannot safely restore the ledger")
        comments_result = subprocess.run(
            ["gh", "api", f"repos/{repo}/pulls/{pr}/reviews/{review_id}/comments",
             "--paginate", "--slurp"],
            capture_output=True, text=True, timeout=30, check=False,
        )
        if comments_result.returncode:
            raise LedgerError(comments_result.stderr.strip() or "Could not inspect pending review comments")
        try:
            comment_pages = json.loads(comments_result.stdout)
        except json.JSONDecodeError as exc:
            raise LedgerError("GitHub returned invalid pending-review comments") from exc
        if (not isinstance(comment_pages, list)
                or any(not isinstance(page, list) for page in comment_pages)):
            raise LedgerError("GitHub returned invalid pending-review comments")
        if any(comment_pages):
            raise LedgerError("Tracked pending review has comments and cannot safely be reused")
        if expected_head is not None and review.get("commit_id") != expected_head:
            raise EmptyPendingReview(
                "Tracked pending review targets an older commit and cannot be reused",
                reusable=False,
            )
        raise EmptyPendingReview("Tracked review is an empty pending draft; start a fresh ledger")
    payload = decode_body(review.get("body"), repo, pr)
    payload["status_summary"] = status_summary(review.get("body"))
    risk = risk_assessment_from_body(review.get("body"))
    if risk is not None:
        payload["risk_assessment"] = risk
    return payload


def write_cycle_ledger(repo_key: str, pr: int, head: str, base: str,
                       ledger: list[dict]) -> str:
    """Write a transient per-cycle copy; GitHub's review body remains authoritative."""
    directory = Path("data/review-context/restored-ledgers")
    directory.mkdir(parents=True, exist_ok=True)
    safe_repo_key = re.sub(r"[^A-Za-z0-9_.-]+", "-", repo_key).strip("-.") or "repo"
    name = f"{safe_repo_key}--{pr}--{head[:12]}--{base[:12]}--{uuid4().hex[:8]}.json"
    path = directory / name
    path.write_text(json.dumps(ledger, indent=2) + "\n")
    return str(path)
