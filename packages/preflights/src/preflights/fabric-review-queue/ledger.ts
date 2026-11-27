import { inflateSync } from "node:zlib";
import { sha } from "./github.js";

/**
 * Decode-side port of the Fabric `review_ledger.py` contract (parity
 * reference: Fabric commit 37d5263). The preflight never encodes ledgers —
 * publication belongs to the runner — but it must restore exactly what the
 * Python preflight restored: `update_count`, the status summary, and the
 * revision-bound risk assessment, validated by the same rules, so a start
 * carries the same values the Python `01-review-queue.py` would have emitted.
 *
 * The one deliberate transport difference: Python wrote the decoded findings
 * to a runner-local `work.ledger_path` file; the dispatcher preflight cannot
 * hand a sandbox a local file, so it emits `work.ledger_restore = "runner"`
 * and the runner restores the same GitHub payload itself (see the README
 * deviation notes).
 */

export class LedgerError extends Error {}

/** The tracked review predates durable ledger payloads (Python class of the same name). */
export class LedgerPayloadMissing extends LedgerError {}

export interface RiskAssessment {
  risk: string;
  explanation: string;
  evidence_files: string[];
  head_sha: string;
  base_sha: string;
}

/** The decoded `review-ledger:v1` payload, plus the restored summary/risk fields. */
export interface LedgerPayload {
  version: number;
  repo: string;
  pr: number;
  head_sha: string;
  base_sha: string;
  update_count: number;
  findings: unknown[];
  status_summary?: string;
  risk_assessment?: RiskAssessment;
}

const MARKER_RE = /<!-- dev-review-bot:review-ledger:v1:([A-Za-z0-9_-]+) -->/g;
const RISK_MARKER_RE = /<!-- dev-review-bot:risk-assessment:v1:([A-Za-z0-9_-]+) -->/g;
const REVISION_RE = /<!-- dev-review-bot:fabric-access-review:([0-9a-f]{40}):([0-9a-f]{40}) -->/g;
const REVIEW_NUMBER_RE = /^## Review ([1-9]\d*)$/gm;
const STATUS_SUMMARY_RE = /^## Review [1-9]\d*\r?\n\r?\n([^\r\n]+)/m;
const FINDING_ID_RE = /^F[1-9]\d*$/;
const REFERENCE_ID_RE = /^R[1-9]\d*$/;
const LEDGER_MARKER_PREFIX = "<!-- dev-review-bot:review-ledger:v1:";
const RISK_MARKER_PREFIX = "<!-- dev-review-bot:risk-assessment:v1:";
const MAX_MARKER_LENGTH = 48_000;
const MAX_RISK_MARKER_LENGTH = 12_000;
const MAX_BODY_LENGTH = 60_000;
const MAX_DECOMPRESSED_BYTES = 1_000_000;

interface Reference {
  id?: string;
  repo: string;
  sha: string;
  file: string;
  line: number;
  url?: string;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new LedgerError(`${field} must be non-empty text`);
  }
  return value.trim();
}

function shaValue(value: unknown, field: string): string {
  if (!sha(value)) {
    throw new LedgerError(`${field} must be a 40-character commit SHA`);
  }
  return value;
}

function reference(value: unknown, field: string): Reference {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new LedgerError(`${field} must be an object`);
  }
  const entry = value as Record<string, unknown>;
  const result: Reference = { repo: "", sha: "", file: "", line: 0 };
  if ("id" in entry) {
    const ident = text(entry.id, `${field}.id`);
    if (!REFERENCE_ID_RE.test(ident)) throw new LedgerError(`${field}.id is invalid`);
    result.id = ident;
  }
  result.repo = text(entry.repo, `${field}.repo`);
  result.sha = shaValue(entry.sha, `${field}.sha`);
  result.file = text(entry.file, `${field}.file`);
  const line = entry.line;
  if (typeof line !== "number" || !Number.isSafeInteger(line) || line < 1) {
    throw new LedgerError(`${field}.line must be a positive integer`);
  }
  result.line = line;
  if (entry.url !== undefined && entry.url !== null) {
    const url = text(entry.url, `${field}.url`);
    if (!url.startsWith("https://github.com/")) {
      throw new LedgerError(`${field}.url must be a GitHub URL`);
    }
    result.url = url;
  }
  return result;
}

/** Structural equality with Python `==` on decoded JSON (order-insensitive objects). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => jsonEqual(item, b[index]));
  }
  if (typeof a === "object") {
    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key) => Object.hasOwn(right, key) && jsonEqual(left[key], right[key]));
  }
  return false;
}

/**
 * Keep only resume data already represented in public review comments — the
 * Python `public_ledger` validator, ported field-for-field so a payload with
 * anything outside the public schema is rejected, never silently trimmed.
 */
export function publicLedger(ledger: unknown, label = "Ledger"): unknown[] {
  if (!Array.isArray(ledger)) throw new LedgerError(`${label} must be an array`);
  const output: unknown[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < ledger.length; index += 1) {
    const entry = ledger[index];
    const field = `ledger[${index}]`;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new LedgerError(`${field} must be an object`);
    }
    const record = entry as Record<string, unknown>;
    const ident = text(record.id, `${field}.id`);
    if (!FINDING_ID_RE.test(ident) || seen.has(ident)) {
      throw new LedgerError(`${field}.id must be unique and use F1, F2, ... format`);
    }
    seen.add(ident);
    const status = record.status ?? "open";
    if (typeof status !== "string" || !["open", "addressed", "rejected"].includes(status)) {
      throw new LedgerError(`${field}.status must be open, addressed, or rejected`);
    }
    const severity = record.severity ?? "not recorded";
    if (typeof severity !== "string" || severity.trim() === "") {
      throw new LedgerError(`${field}.severity must be text`);
    }
    const dimensions = record.source_dimensions ?? [];
    if (
      !Array.isArray(dimensions) ||
      dimensions.some((name) => typeof name !== "string" || name.trim() === "")
    ) {
      throw new LedgerError(`${field}.source_dimensions must be an array of names`);
    }

    const publicEntry: Record<string, unknown> = {
      id: ident,
      status,
      severity: severity.trim(),
      source_dimensions: [...new Set(dimensions.map((name) => (name as string).trim()))],
    };
    const category = record.category;
    if (typeof category === "string" && category.trim() !== "") {
      publicEntry.category = category.trim();
    }
    for (const key of ["first_flagged_sha", "last_checked_sha"] as const) {
      if (key in record) publicEntry[key] = shaValue(record[key], `${field}.${key}`);
    }
    if (status === "rejected") {
      publicEntry.status_note = text(record.status_note, `${field}.status_note`);
    }

    ensurePublicContent(JSON.stringify(publicEntry), `Ledger finding ${ident}`);
    if (status === "addressed" || status === "rejected") {
      output.push(publicEntry);
      continue;
    }

    const location = record.location;
    if (location === null || typeof location !== "object" || Array.isArray(location)) {
      throw new LedgerError(`${field}.location must be an object`);
    }
    const locationRecord = location as Record<string, unknown>;
    const side = locationRecord.side;
    if (typeof side !== "string" || !["added", "removed"].includes(side)) {
      throw new LedgerError(`${field}.location.side must be added or removed`);
    }
    const line = locationRecord.line;
    if (typeof line !== "number" || !Number.isSafeInteger(line) || line < 1) {
      throw new LedgerError(`${field}.location.line must be a positive integer`);
    }
    publicEntry.location = {
      repo: text(locationRecord.repo, `${field}.location.repo`),
      file: text(locationRecord.file, `${field}.location.file`),
      line,
      side,
    };
    for (const key of ["claim", "trigger", "impact", "suggested_fix"] as const) {
      publicEntry[key] = text(record[key], `${field}.${key}`);
    }
    for (const key of ["expected_result", "actual_result"] as const) {
      if (key in record) publicEntry[key] = text(record[key], `${field}.${key}`);
    }
    const scenario = record.scenario;
    if (
      !Array.isArray(scenario) ||
      scenario.some((step) => typeof step !== "string" || step.trim() === "")
    ) {
      throw new LedgerError(`${field}.scenario must be an array of text`);
    }
    publicEntry.scenario = scenario.map((step) => (step as string).trim());
    const evidence = record.evidence;
    if (evidence === null || typeof evidence !== "object" || Array.isArray(evidence)) {
      throw new LedgerError(`${field}.evidence must be an object`);
    }
    const refs = Array.isArray(record.refs) ? record.refs : [];
    const evidenceRecord = evidence as Record<string, unknown>;
    const evidenceRefs = Array.isArray(evidenceRecord.refs) ? evidenceRecord.refs : [];
    const publicRefs = refs.map((ref, refIndex) => reference(ref, `${field}.refs[${refIndex}]`));
    const normalizedEvidenceRefs = evidenceRefs.map((ref, refIndex) =>
      reference(ref, `${field}.evidence.refs[${refIndex}]`),
    );
    if (!jsonEqual(publicRefs, normalizedEvidenceRefs)) {
      throw new LedgerError(`${field}.refs and evidence.refs must match`);
    }
    publicEntry.refs = publicRefs;
    publicEntry.evidence = {
      explanation: text(evidenceRecord.explanation, `${field}.evidence.explanation`),
      refs: normalizedEvidenceRefs,
    };

    ensurePublicContent(JSON.stringify(publicEntry), `Ledger finding ${ident}`);
    output.push(publicEntry);
  }
  return output;
}

/**
 * Decompress one ledger payload with Python's limits: at most
 * {@link MAX_DECOMPRESSED_BYTES} bytes of output and no trailing input after
 * the stream end (the `decompressobj().unused_data` check).
 */
function inflatePayload(compressed: Buffer): Buffer {
  let raw: Buffer;
  try {
    // `info: true` exposes the engine's consumed-input count, which stands in
    // for Python's `decompressobj().unused_data` check on trailing input.
    const result = inflateSync(compressed, {
      maxOutputLength: MAX_DECOMPRESSED_BYTES + 1,
      info: true,
    }) as unknown as { buffer: Buffer; engine?: { bytesWritten?: number } };
    raw = result.buffer;
    const consumed = result.engine?.bytesWritten;
    if (consumed !== undefined && consumed !== compressed.length) {
      throw new LedgerError("Ledger payload compression is invalid");
    }
  } catch (error) {
    if (error instanceof LedgerError) throw error;
    if (
      error !== null &&
      typeof error === "object" &&
      (error as { code?: unknown }).code === "ERR_BUFFER_TOO_LARGE"
    ) {
      throw new LedgerError("Decompressed ledger exceeds the safe size limit");
    }
    throw new LedgerError("Ledger payload is not valid compressed JSON");
  }
  if (raw.length > MAX_DECOMPRESSED_BYTES) {
    throw new LedgerError("Decompressed ledger exceeds the safe size limit");
  }
  return raw;
}

function decodeBase64Url(encoded: string): Buffer {
  return Buffer.from(encoded, "base64url");
}

/** Restore the ledger payload embedded in a status review body (Python `decode_body`). */
export function decodeBody(body: unknown, repo: string, pr: number): LedgerPayload {
  if (typeof body !== "string") throw new LedgerError("GitHub review body is missing");
  if (body.length > MAX_BODY_LENGTH) {
    throw new LedgerError("GitHub review body exceeds the safe size limit");
  }
  const matches = [...body.matchAll(MARKER_RE)].map((match) => match[1]);
  if ((body.match(new RegExp(LEDGER_MARKER_PREFIX, "g")) ?? []).length !== matches.length) {
    throw new LedgerError("Tracked review contains a malformed ledger payload marker");
  }
  if (matches.length === 0) {
    if (body.includes(LEDGER_MARKER_PREFIX)) {
      throw new LedgerError("Tracked review contains a malformed ledger payload marker");
    }
    throw new LedgerPayloadMissing("Tracked review has no embedded ledger payload");
  }
  if (matches.length !== 1) {
    throw new LedgerError("Tracked review contains multiple ledger payloads");
  }
  const encoded = matches[0];
  if (encoded.length > MAX_MARKER_LENGTH) {
    throw new LedgerError("Ledger payload exceeds the safe size limit");
  }
  const raw = inflatePayload(decodeBase64Url(encoded));
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new LedgerError("Ledger payload is not valid compressed JSON");
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    (parsed as Record<string, unknown>).version !== 1 ||
    (parsed as Record<string, unknown>).repo !== repo ||
    (parsed as Record<string, unknown>).pr !== pr
  ) {
    throw new LedgerError("Ledger payload belongs to another schema, repository, or PR");
  }
  const payload = parsed as Record<string, unknown>;
  const head = shaValue(payload.head_sha, "head_sha");
  const base = shaValue(payload.base_sha, "base_sha");
  const updateCount = payload.update_count;
  if (typeof updateCount !== "number" || !Number.isSafeInteger(updateCount) || updateCount < 0) {
    throw new LedgerError("Ledger payload update_count is invalid");
  }
  const revisions = [...body.matchAll(REVISION_RE)].map((match) => [match[1], match[2]]);
  if (!jsonEqual(revisions, [[head, base]])) {
    throw new LedgerError("Ledger SHAs do not match the status comment revision marker");
  }
  const reviewNumbers = [...body.matchAll(REVIEW_NUMBER_RE)].map((match) => match[1]);
  if (!jsonEqual(reviewNumbers, [String(updateCount + 1)])) {
    throw new LedgerError("Ledger update count does not match the status heading");
  }
  const findings = publicLedger(payload.findings);
  if (!jsonEqual(findings, payload.findings)) {
    throw new LedgerError("Ledger payload contains fields outside the public resume schema");
  }
  return {
    version: 1,
    repo,
    pr,
    head_sha: head,
    base_sha: base,
    update_count: updateCount,
    findings,
  };
}

/** Extract the one-line PR purpose sentence (Python `status_summary`). */
export function statusSummary(body: unknown): string | null {
  if (typeof body !== "string") return null;
  const match = STATUS_SUMMARY_RE.exec(body);
  if (!match) return null;
  const summary = match[1].trim();
  return summary === "" ? null : summary;
}

/** Restore an optional revision-bound risk assessment (Python `risk_assessment_from_body`). */
export function riskAssessmentFromBody(body: unknown): RiskAssessment | null {
  if (typeof body !== "string" || body.length > MAX_BODY_LENGTH) {
    throw new LedgerError("Status review body is invalid for risk restoration");
  }
  const matches = [...body.matchAll(RISK_MARKER_RE)].map((match) => match[1]);
  if ((body.match(new RegExp(RISK_MARKER_PREFIX, "g")) ?? []).length !== matches.length) {
    throw new LedgerError("Status review has a malformed risk-assessment marker");
  }
  if (matches.length === 0) return null;
  if (matches.length !== 1 || matches[0].length > MAX_RISK_MARKER_LENGTH) {
    throw new LedgerError("Status review has multiple or oversized risk assessments");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeBase64Url(matches[0]).toString("utf8"));
  } catch {
    throw new LedgerError("Status review risk assessment is malformed");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new LedgerError("Status review risk assessment has an unsupported schema");
  }
  const payload = parsed as Record<string, unknown>;
  const expectedKeys = ["version", "risk", "explanation", "evidence_files", "head_sha", "base_sha"];
  const keys = Object.keys(payload).sort();
  if (
    !jsonEqual(keys, [...expectedKeys].sort()) ||
    payload.version !== 1 ||
    typeof payload.risk !== "string" ||
    !["low", "medium", "high"].includes(payload.risk)
  ) {
    throw new LedgerError("Status review risk assessment has an unsupported schema");
  }
  const explanation = text(payload.explanation, "risk_assessment.explanation");
  const files = payload.evidence_files;
  if (
    !Array.isArray(files) ||
    files.length < 1 ||
    files.length > 8 ||
    files.some((path) => typeof path !== "string" || path.trim() === "") ||
    new Set(files).size !== files.length
  ) {
    throw new LedgerError("Status review risk assessment evidence_files is invalid");
  }
  const head = shaValue(payload.head_sha, "risk_assessment.head_sha");
  const base = shaValue(payload.base_sha, "risk_assessment.base_sha");
  const restored: RiskAssessment = {
    risk: payload.risk,
    explanation,
    evidence_files: files.map((path) => (path as string).trim()),
    head_sha: head,
    base_sha: base,
  };
  ensurePublicContent(JSON.stringify(restored), "Risk assessment");
  return restored;
}

/**
 * Reject recognizable credential material — the Python
 * `ensure_public_content` guard, ported pattern-for-pattern. The ledger
 * payload is public (any PR reader can extract it), so a payload carrying
 * credential-looking content fails closed instead of being restored.
 */
const SAFETY_PATTERNS: readonly [string, RegExp][] = [
  [
    "private-key material",
    /-----BEGIN (?:ENCRYPTED |RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----|-----BEGIN PGP PRIVATE KEY BLOCK-----/i,
  ],
  ["AWS access key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/],
  ["OpenAI token", /\bsk-(?:(?:proj|svcacct)-[A-Za-z0-9_-]{20,}|[A-Za-z0-9]{40,})\b/],
  ["Anthropic token", /\bsk-ant-[A-Za-z0-9_-]{20,}\b/],
  ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["Stripe secret key", /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/],
  ["bearer credential", /\bAuthorization\s*:\s*Bearer\s+[A-Za-z0-9._~+/-]{20,}={0,2}/i],
  ["credential-bearing URL", /https?:\/\/[^\s/:@]+:[^\s/@]+@[^\s/]+/i],
  [
    "credential assignment",
    /\b(?:password|passwd|secret|api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret)\b\s*[:=]\s*(?:["'`]([^"'`\s,;}]{8,})["'`]|([A-Za-z0-9_./+=-]{24,}))/i,
  ],
  ["US Social Security number", /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/],
];

const EMAIL_RE =
  /\b[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@(?<domain>[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+)\b/gi;
const RESERVED_EMAIL_DOMAINS = new Set([
  "example.com",
  "example.net",
  "example.org",
  "localhost",
  "invalid",
  "test",
]);
const CARD_NUMBER_RE = /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g;

function isPaymentCard(value: string): boolean {
  const digits = value.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  let total = 0;
  const parity = digits.length % 2;
  for (let index = 0; index < digits.length; index += 1) {
    let number = Number(digits[index]);
    if (index % 2 === parity) {
      number *= 2;
      if (number > 9) number -= 9;
    }
    total += number;
  }
  return total % 10 === 0;
}

export function ensurePublicContent(value: unknown, label: string): void {
  if (typeof value !== "string") throw new LedgerError(`${label} must be text`);
  for (const [name, pattern] of SAFETY_PATTERNS) {
    if (pattern.test(value)) {
      throw new LedgerError(
        `${label} contains recognizable ${name}; remove the value before publication`,
      );
    }
  }
  for (const match of value.matchAll(EMAIL_RE)) {
    const domain = (match.groups?.domain ?? "").toLowerCase();
    if (
      !RESERVED_EMAIL_DOMAINS.has(domain) &&
      !domain.endsWith(".example") &&
      !domain.endsWith(".invalid") &&
      !domain.endsWith(".test")
    ) {
      throw new LedgerError(`${label} contains an email address; remove it before publication`);
    }
  }
  if ([...value.matchAll(CARD_NUMBER_RE)].some((match) => isPaymentCard(match[0]))) {
    throw new LedgerError(
      `${label} contains a recognizable payment-card number; remove it before publication`,
    );
  }
}
