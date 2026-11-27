import { createHash } from "node:crypto";
import { z } from "zod";
import { definePreflight } from "../../core/registry.js";
import type { PreflightExecutionResult } from "../../core/results.js";
import { ACTIVE_TASK_STATUSES, type MemoryTask } from "../../shared/memory-server.js";
import type { PreflightRunContext } from "../../shared/run-context.js";
import {
  id,
  login,
  object,
  type Pull,
  type RecordData,
  type ReviewGitHub,
  reviewGitHub,
  timestamp,
} from "./github.js";
import {
  decodeBody,
  LedgerPayloadMissing,
  type LedgerPayload,
  type RiskAssessment,
  riskAssessmentFromBody,
  statusSummary,
} from "./ledger.js";

/**
 * Port of the Fabric review-only preflight `01-review-queue.py` (parity
 * reference: Fabric commit 37d5263). When this preflight `start`s, the start
 * content — `{"work": …, "discovery_errors": […]}` — carries the same fields
 * and values the Python preflight emitted, because the migrated agent runner
 * parses it unchanged; the approval, resume, recovery, and
 * pending-publication paths are pinned field-for-field (and their consent
 * comments byte-for-byte) against the vendored Python golden driver in
 * `test/fixtures/fabric-review-queue-python/`. Deliberate deviations (the
 * runner ledger hand-off, input hardening, and the documented
 * reused-approval ABA parity) are listed in the package README.
 */

const ID = "fabric-review-queue";
const PREFIX = "review-only:github:";
const EPOCH = "1970-01-01T00:00:00Z";
/** Python `REVIEWABLE_BOT_AUTHORS` — self-authored PRs this queue reviews. */
const ALLOWED_SELF_AUTHOR = "platex-rehor-bot";
const ACTIVE = new Set(ACTIVE_TASK_STATUSES);
const COMMANDABLE = new Set([...ACTIVE, "done"]);
const RESUMABLE = new Set(["in_progress", "pr_changes"]);
const FOOTER_START = "<!-- dev-review-bot:comment-footer:start -->";
const FOOTER_END = "<!-- dev-review-bot:comment-footer:end -->";
const MAX_COMMANDS_PER_CYCLE = 5;
const MAX_REQUEST_LENGTH = 4000;
const LEARNING_REQUEST = "learning-extraction";
const CAPACITY_MAX = 10;

const input = z.strictObject({
  review_label: z
    .string()
    .trim()
    .min(1)
    .max(50)
    .regex(/^[^,\r\n]+$/),
  bot_login: z.string().refine(login),
});

type Kind =
  | "review"
  | "resume"
  | "verify"
  | "feedback_check"
  | "command_reply"
  | "merge_complete"
  | "closed_unmerged"
  | "reconcile_open";
type Source = "issue" | "review-comment" | "review";
type ApprovalState = "waiting" | "declined" | "verification_unavailable" | "approved";

/** One contextual `/review-bot` request — Python `bot_command_requests` entry. */
interface CommandRequest {
  id: number;
  source: Source;
  feedback_id: string;
  login: string;
  created_at: string;
  url: string;
  request: string;
  too_long: boolean;
  action?: string;
}

/**
 * The emitted work object. Field set and insertion order follow Python's
 * `candidate()` dict plus its later mutations, so `JSON.stringify` produces
 * the same shape the Python `json.dumps` printed (key order is not semantic
 * to the runner; values are).
 */
interface Work {
  kind: Kind;
  task_key: string;
  task_exists: boolean;
  task_active: boolean;
  repo_key: string;
  repo: string;
  number: number;
  title: string;
  url: string;
  head_sha: string;
  base_sha: string;
  /** Present on candidate()-built work; Python's lifecycle_work omits both. */
  head_branch?: string;
  pr_author?: string;
  updated_at: string;
  merged_at?: string;
  review_label_event_id?: number;
  review_authorization?: "label_added" | "approval_required" | "organization_member_approved";
  command_requests?: CommandRequest[];
  feedback_comment_ids?: string[];
  task_status?: string;
  /** Tracked review ID — on command_reply work like Python, and on every
   * ledger_restore start because the runner-restoration CLI requires it. */
  status_review_id?: number;
  verify_comment_ids?: number[];
  rereview_comment_ids?: number[];
  review_approval_id?: string;
  review_approval_response_comment_id?: number;
  review_approval_responder?: string;
  ledger_restore?: "runner";
  ledger_restore_pending?: true;
  update_count?: number;
  pr_summary?: string;
  risk_assessment?: RiskAssessment;
  ignore_review_id?: true;
  ledger_recovery_approved?: true;
  /** Python sets this on the chosen work before every recovery outcome; only
   * "approved" survives into a start (`chosen` is the emitted work dict). */
  ledger_recovery_state?: "approved";
  ledger_recovery_response_comment_id?: number;
  ledger_recovery_responder?: string;
}

interface Candidate {
  priority: number;
  /** The tracked task's status (never emitted except on command_reply work). */
  status: string | undefined;
  listed: boolean;
  meta: RecordData;
  pull: Pull;
  work: Work;
}

function metadata(task?: MemoryTask): RecordData {
  const raw: unknown = task?.metadata;
  if (raw === undefined || raw === null) return {};
  const parsed: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!object(parsed)) throw new Error("Invalid review task metadata");
  return parsed;
}

function seen<T>(value: unknown, valid: (item: unknown) => item is T): Set<T> {
  if (value === undefined || value === null) return new Set();
  if (!Array.isArray(value) || !value.every(valid))
    throw new Error("Invalid review task watermark IDs");
  return new Set(value);
}

const string = (value: unknown): value is string => typeof value === "string";

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message !== "" ? error.message : String(error);
}

/** The newest `labeled` event for the configured label (Python `_latest_review_label_event`). */
function newerLabel(events: RecordData[], label: string, candidate: Candidate): boolean {
  const { meta, work } = candidate;
  const latest = events
    .flatMap((event) => {
      if (
        event.event !== "labeled" ||
        !object(event.label) ||
        typeof event.label.name !== "string" ||
        event.label.name.toLowerCase() !== label
      )
        return [];
      const at = timestamp(event.created_at);
      // A labeled event without a usable id or timestamp cannot be trusted to
      // authorize anything: fail closed instead of ignoring it (TS hardening).
      if (!id(event.id) || !Number.isFinite(at)) throw new Error("Invalid review label event");
      return [{ id: event.id, at }];
    })
    .sort((a, b) => b.at - a.at || b.id - a.id)[0];
  const saved = meta.review_label_event_id;
  if (saved !== undefined && saved !== null && !id(saved))
    throw new Error("Invalid stored review label event");
  if (latest) work.review_label_event_id = latest.id;
  else if (id(saved)) work.review_label_event_id = saved;
  if (!latest) return false;
  if (id(saved)) return latest.id > saved;
  return !meta.last_reviewed_sha || latest.at > timestamp(meta.last_reviewed_at);
}

interface Comment {
  source: Source;
  id: number;
  key: string;
  login: string;
  loginRaw: string;
  user: boolean;
  body: string;
  created: number;
  createdRaw: string;
  updated: number;
  original: boolean;
  htmlUrl: string | null;
}

function comments(rows: RecordData[], source: Source): Comment[] {
  if (source === "issue") {
    // A malformed issue-comment feed fails closed (TS hardening): a comment
    // that cannot be attributed or dated must not influence approval,
    // commands, or feedback.
    const ids = new Set<number>();
    for (const row of rows) {
      const created = timestamp(row.created_at);
      const updated = timestamp(row.updated_at);
      if (
        !id(row.id) ||
        ids.has(row.id) ||
        !object(row.user) ||
        !login(row.user.login) ||
        !["User", "Bot"].includes(String(row.user.type)) ||
        typeof row.body !== "string" ||
        !Number.isFinite(created) ||
        !Number.isFinite(updated) ||
        updated < created
      )
        throw new Error("Incomplete GitHub issue comment feed");
      ids.add(row.id);
    }
  }
  return rows.flatMap((row) => {
    if (
      !id(row.id) ||
      !object(row.user) ||
      !login(row.user.login) ||
      typeof row.body !== "string" ||
      (source === "review" &&
        !["COMMENTED", "APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(String(row.state)))
    )
      return [];
    const created = timestamp(source === "review" ? row.submitted_at : row.created_at);
    const updated = timestamp(row.updated_at ?? row.created_at ?? row.submitted_at);
    return [
      {
        source,
        id: row.id,
        key: `${source}:${row.id}`,
        login: row.user.login.toLowerCase(),
        loginRaw: row.user.login,
        user: row.user.type === "User",
        body: row.body,
        created,
        createdRaw: String(source === "review" ? row.submitted_at : row.created_at),
        updated,
        original:
          source === "review" ? row.state !== "DISMISSED" : row.created_at === row.updated_at,
        htmlUrl: typeof row.html_url === "string" ? row.html_url : null,
      },
    ];
  });
}

type Member = (repo: string, user: string) => Promise<boolean>;
function memberCheck(github: ReviewGitHub): Member {
  // Python's _ORG_MEMBER_CACHE: successes (member or not) are cached for the
  // run; a verification failure is not, so a later check retries it.
  const cache = new Map<string, Promise<boolean>>();
  return async (repo, user) => {
    const org = repo.split("/", 1)[0];
    const key = `${org.toLowerCase()}/${user}`;
    const cached = cache.get(key);
    if (cached) return cached;
    const check = github.member(org, user);
    cache.set(key, check);
    try {
      return await check;
    } catch (error) {
      cache.delete(key);
      throw error;
    }
  };
}

const chronological = (a: Comment, b: Comment) => a.created - b.created || a.id - b.id;
const byCommandOrder = (a: Comment, b: Comment) =>
  a.created - b.created ||
  (a.source < b.source ? -1 : a.source > b.source ? 1 : 0) ||
  a.id - b.id;
const within = (value: number, since: number, through: number) =>
  since <= value && value <= through;

/** Python `parse_request` with `allow_special` derived from the source. */
function parseCommandRequest(comment: Comment, repo: string, number: number): CommandRequest | null {
  const match = /^\/review-bot(?=$|\s)([\s\S]*)$/i.exec(comment.body.trimStart());
  if (!match) return null;
  let request = match[1].trim();
  if (comment.source === "issue" && ["verify", "re-review"].includes(request.toLowerCase())) {
    return null;
  }
  let tooLong = false;
  if (request.length > MAX_REQUEST_LENGTH) {
    request = "";
    tooLong = true;
  }
  const prefix = `https://github.com/${repo}/pull/${number}#`;
  let url = comment.htmlUrl;
  if (url === null || !url.startsWith(prefix)) {
    url =
      comment.source === "issue"
        ? `${prefix}issuecomment-${comment.id}`
        : comment.source === "review-comment"
          ? `${prefix}discussion_r${comment.id}`
          : `${prefix}pullrequestreview-${comment.id}`;
  }
  const entry: CommandRequest = {
    id: comment.id,
    source: comment.source,
    feedback_id: comment.key,
    login: comment.loginRaw,
    created_at: comment.createdRaw,
    url,
    request,
    too_long: tooLong,
  };
  if (request.toLowerCase() === LEARNING_REQUEST) entry.action = LEARNING_REQUEST;
  return entry;
}

/** Python `_external_feedback_key`'s two issue-comment exclusions. */
function excludedFeedback(comment: Comment): boolean {
  if (comment.source !== "issue") return false;
  const stripped = comment.body.trim();
  return (
    /^\/review-bot\s+(?:re-review|verify)$/i.test(stripped) ||
    /^Review bot: no LR-[0-9a-f]{12}$/i.test(stripped)
  );
}

async function scanFeedback(
  candidate: Candidate,
  all: Comment[],
  bot: string,
  member: Member,
  contextOnly: boolean,
  labelAdded: boolean,
): Promise<boolean> {
  const { work, meta, status } = candidate;
  const since = timestamp(meta.last_seen_updated_at || meta.last_reviewed_at || EPOCH);
  const through = timestamp(work.updated_at);
  if (!Number.isFinite(since) || since > through) throw new Error("Invalid review task watermark");
  const seenFeedback = seen(meta.seen_feedback_comment_ids, string);
  const humans = [
    ...new Map(all.filter((c) => c.user && c.login !== bot).map((c) => [c.key, c])).values(),
  ];

  const requests: CommandRequest[] = [];
  for (const c of [...humans].sort(byCommandOrder)) {
    if (!c.original || !within(c.created, since, Date.now()) || seenFeedback.has(c.key)) continue;
    const request = parseCommandRequest(c, work.repo, work.number);
    // Python membership-checks only parsed command authors, never every
    // commenter in the window.
    if (!request || !(await member(work.repo, c.login))) continue;
    requests.push(request);
    if (requests.length === MAX_COMMANDS_PER_CYCLE) break;
  }
  if (requests.length) {
    work.kind = "command_reply";
    candidate.priority = 1;
    work.command_requests = requests;
    work.feedback_comment_ids = requests.map((request) => request.feedback_id);
    work.task_status = status;
    if (id(meta.review_id)) work.status_review_id = meta.review_id;
    delete work.review_authorization;
    delete work.review_label_event_id;
    return true;
  }
  if (contextOnly) return false;

  const exact = async (command: string, seenValue: unknown): Promise<number[]> => {
    const processed = seen(seenValue, id);
    const ids: number[] = [];
    for (const c of [...humans].sort(chronological)) {
      if (
        c.source === "issue" &&
        c.original &&
        within(c.created, since, through) &&
        !processed.has(c.id) &&
        c.body.trim().toLowerCase() === `/review-bot ${command}` &&
        (await member(work.repo, c.login))
      )
        ids.push(c.id);
    }
    return ids;
  };
  if (
    !labelAdded &&
    work.kind !== "resume" &&
    status === "pr_open" &&
    id(meta.review_id) &&
    (meta.last_reviewed_sha || meta.update_count)
  ) {
    const ids = await exact("verify", meta.seen_verify_comment_ids);
    if (ids.length) {
      work.verify_comment_ids = ids;
      work.kind = "verify";
      candidate.priority = 1;
      work.feedback_comment_ids = [];
      delete work.review_authorization;
      delete work.rereview_comment_ids;
      return true;
    }
  }
  if (work.kind !== "resume") {
    const ids = await exact("re-review", meta.seen_rereview_comment_ids);
    if (ids.length) {
      work.rereview_comment_ids = ids;
      work.kind = "review";
      candidate.priority = 1;
      // A re-review command never authorizes by itself: Python overwrites a
      // label-added authorization with approval_required here, and so does
      // this port — an explicit decision is still required.
      work.review_authorization = "approval_required";
    }
  }
  const feedback: string[] = [];
  if (work.kind === "review" || work.kind === "feedback_check") {
    for (const c of humans) {
      if (within(c.updated, since, through) && !seenFeedback.has(c.key) && !excludedFeedback(c))
        feedback.push(c.key);
    }
  }
  work.feedback_comment_ids = feedback;
  return !(work.kind === "feedback_check" && feedback.length === 0);
}

function decisionId(candidate: Candidate, mode: "RA" | "LR"): string {
  const { work, meta } = candidate;
  const ids = work.rereview_comment_ids;
  const parts = [
    work.repo,
    work.number,
    ...(mode === "LR" ? [meta.review_id, meta.last_reviewed_sha, meta.last_reviewed_base_sha] : []),
    work.head_sha,
    work.base_sha,
    ...(mode === "RA"
      ? [ids?.length ? `rereview:${[...ids].sort((a, b) => a - b).join(",")}` : "revision"]
      : []),
  ];
  return `${mode}-${createHash("sha256")
    .update(parts.map((part) => part || "").join("|"))
    .digest("hex")
    .slice(0, 12)}`;
}

/** Python `_status_review_url`: the footer link only when metadata confirms it. */
function statusReviewUrl(meta: RecordData, repo: string, number: number): string | null {
  const ident = meta.review_id;
  const url = meta.review_url;
  const expected = id(ident)
    ? `https://github.com/${repo}/pull/${number}#pullrequestreview-${ident}`
    : null;
  return typeof url === "string" && url === expected ? url : null;
}

/** Python `with_footer` for freshly built bot request comments. */
function withFooter(body: string, reviewUrl: string | null): string {
  const steps: string[] = [];
  const question = /<!-- dev-review-bot:missing-context:(Q-[0-9a-f]{12}) -->/.exec(body);
  const approval = /<!-- dev-review-bot:review-approval:(RA-[0-9a-f]{12}) -->/.exec(body);
  const recovery = /<!-- dev-review-bot:ledger-recovery:(LR-[0-9a-f]{12}) -->/.exec(body);
  if (question) steps.push(`- Answer this question with \`Answer ${question[1]}: ...\`.`);
  if (approval)
    steps.push(
      `- Approve with \`Review bot: yes ${approval[1]}\` or decline with \`Review bot: no ${approval[1]}\`.`,
    );
  if (recovery)
    steps.push(
      `- Approve a fresh review with \`Review bot: yes ${recovery[1]}\` or decline with \`Review bot: no ${recovery[1]}\`.`,
    );
  steps.push("- Comment `/review-bot <question or request>` for an answer based on the pinned PR and review context.");
  steps.push("- Comment `/review-bot learning-extraction` to ask for reusable lessons from this PR.");
  if (reviewUrl) {
    steps.push("- After changes, comment `/review-bot verify` to recheck existing findings.");
    steps.push("- Comment `/review-bot re-review` to request a full review (approval required).");
  }
  const status = reviewUrl
    ? `**Status Comment:** [View review status](${reviewUrl})`
    : "**Status Comment:** Pending the first review.";
  const footer = [FOOTER_START, "---", "", status, "", "**Next steps:**", ...steps, FOOTER_END].join(
    "\n",
  );
  return `${body}\n\n${footer}`;
}

/** Python `_approval_request_body` / `_request_ledger_recovery`'s request body. */
function botRequest(candidate: Candidate, mode: "RA" | "LR", key: string): string {
  const { work, meta } = candidate;
  const marker = `<!-- dev-review-bot:${mode === "RA" ? "review-approval" : "ledger-recovery"}:${key} -->`;
  const body =
    mode === "RA"
      ? `### Review approval required\n\n**Request:** \`${key}\`\n\n**Reason:** ${
          work.rereview_comment_ids?.length
            ? "A re-review was requested without a new review-label event."
            : meta.last_reviewed_sha
              ? "The PR head or base changed since the last review."
              : "The configured review label has no new label-add event."
        }\n\n**Target revision**\n- **Head:** \`${work.head_sha.slice(0, 12)}\`\n- **Base:** \`${work.base_sha.slice(0, 12)}\`\n\nNo review will run until an organization member approves this exact revision.\n\n**Reply with one option:**\n- \`Review bot: yes ${key}\` — approve and start the review.\n- \`Review bot: no ${key}\` — decline the review.\n\n${marker}`
      : `**Review history needs recovery (${key}).**\n\nI could not find a usable ledger in the status review, saved publication, or local ledger. A fresh review will restart the finding history and may assign new finding IDs. Should a fresh re-review run? Any member of the repository's GitHub organization can include \`Review bot: yes ${key}\` to approve, or \`Review bot: no ${key}\` to decline, anywhere in their comment.\n\n${marker}`;
  return withFooter(body, statusReviewUrl(meta, work.repo, work.number));
}

/**
 * Request and evaluate one organization-member decision (review approval or
 * ledger recovery), Python `_request_review_approval` /
 * `_request_ledger_recovery`. Semantics mirror Python exactly: the request
 * comment is rebound in place with PATCH only when no existing request
 * carries the current decision id; a reply counts when it is strictly later
 * than the request's creation, carries exactly one decision, and comes from
 * a verified organization member; the latest reply by (created, id) wins;
 * and a membership-verification failure is a per-PR
 * `verification_unavailable` wait, never a run-wide error. Comment edits are
 * invisible to Python and to this port (see the README's reused-approval
 * note).
 */
async function decision(
  candidate: Candidate,
  mode: "RA" | "LR",
  github: ReviewGitHub,
  issue: Comment[],
  bot: string,
  member: Member,
): Promise<ApprovalState> {
  const { work } = candidate;
  const key = decisionId(candidate, mode);
  const marker = `<!-- dev-review-bot:${mode === "RA" ? "review-approval" : "ledger-recovery"}:${key} -->`;
  const marked = issue
    .filter(
      (c) =>
        c.login === bot &&
        (mode === "LR"
          ? c.body.includes(marker)
          : /<!-- dev-review-bot:review-approval:RA-[0-9a-f]{12} -->/.test(c.body)),
    )
    .sort(chronological);
  const matching = mode === "RA" ? marked.filter((c) => c.body.includes(marker)) : marked;
  const request = matching[0] ?? marked[0];
  const rebind = mode === "RA" && matching.length === 0 && marked.length > 0;
  if (!request || rebind) {
    if (mode === "RA") await github.waitingLabel(work.repo, work.number, true);
    const body = botRequest(candidate, mode, key);
    if (rebind) await github.updateRequest(work.repo, request.id, body);
    else await github.postRequest(work.repo, work.number, body);
    return "waiting";
  }
  const pattern = new RegExp(`Review bot:\\s*(yes|no)\\s+${key}(?![A-Za-z0-9_-])`, "gi");
  let reply: Comment | undefined;
  let yes = false;
  for (const c of issue.filter((c) => c.user && c.login !== bot).sort(chronological)) {
    if (c.created < request.created || (c.created === request.created && c.id <= request.id))
      continue;
    const decisions = new Set([...c.body.matchAll(pattern)].map((match) => match[1].toLowerCase()));
    if (decisions.size !== 1) continue;
    let isMember: boolean;
    try {
      isMember = await member(work.repo, c.login);
    } catch {
      return "verification_unavailable";
    }
    if (!isMember) continue;
    if (!reply || c.created > reply.created || (c.created === reply.created && c.id > reply.id)) {
      reply = c;
      yes = decisions.has("yes");
    }
  }
  if (!reply) {
    if (mode === "RA") await github.waitingLabel(work.repo, work.number, true);
    return "waiting";
  }
  if (mode === "RA") await github.waitingLabel(work.repo, work.number, false);
  if (!yes) {
    if (mode === "LR") {
      work.ledger_recovery_response_comment_id = reply.id;
      work.ledger_recovery_responder = reply.login;
    }
    return "declined";
  }
  if (mode === "RA") {
    work.review_authorization = "organization_member_approved";
    work.review_approval_id = key;
    work.review_approval_response_comment_id = reply.id;
    work.review_approval_responder = reply.login;
  } else {
    work.ledger_recovery_approved = true;
    work.ledger_recovery_state = "approved";
    work.ledger_recovery_response_comment_id = reply.id;
    work.ledger_recovery_responder = reply.login;
  }
  return "approved";
}

type RestoreResult = "ready" | "missing" | "older-draft";

/**
 * Restore the prior review state for a start, Python `restore_prior_ledger`.
 * Decodes the same payloads with the same validation so `update_count`,
 * `pr_summary`, and `risk_assessment` carry Python's values — including
 * Python's pending-publication semantics: the saved body is used only when
 * it decodes and its embedded revision matches the chosen head/base, and an
 * unusable pending publication is skipped, never an error. The Python
 * `work.ledger_path` file hand-off is replaced by the runner-restoration
 * contract (Fabric `restore_review_ledger.py` + its SKILL.md): restored
 * starts carry `ledger_restore: "runner"`, `status_review_id` (the tracked
 * review the CLI must re-read — a deliberate deviation from Python, which
 * emits that field only on command_reply work), and `ledger_restore_pending`
 * for a matching pending publication (the CLI's `--pending` retry path). A
 * legacy `metadata.ledger_path` from the pre-migration runtime is not
 * readable and falls through to ledger recovery, as does a pending-only
 * payload without a tracked review id (the CLI requires one).
 */
async function restoration(
  candidate: Candidate,
  github: ReviewGitHub,
  bot: string,
): Promise<RestoreResult> {
  const { work, meta, status } = candidate;
  if (!["review", "resume", "feedback_check", "verify"].includes(work.kind)) return "ready";
  const historical = Boolean(
    meta.review_id ||
      meta.last_reviewed_sha ||
      meta.update_count ||
      status === "pr_open" ||
      status === "pr_changes",
  );
  if (!historical) {
    if (work.kind === "verify") return "missing";
    work.update_count = 0;
    return "ready";
  }
  let pending: RecordData | undefined;
  let pendingMatches = false;
  if (object(meta.pending_publication)) {
    // Python reads only the saved body and its embedded revision: an
    // unusable or stale pending publication is skipped, never an error, and
    // the runner CLI re-validates the full publication on its `--pending`
    // path.
    pending = meta.pending_publication;
    pendingMatches = pending.head_sha === work.head_sha && pending.base_sha === work.base_sha;
  }
  if (meta.review_id !== undefined && meta.review_id !== null && !id(meta.review_id))
    throw new Error("Tracked review ID is invalid");
  // The runner-restoration CLI (Fabric restore_review_ledger.py) is invoked
  // with work.status_review_id and requires it to equal the task's tracked
  // metadata.review_id, so every ledger_restore start must carry it.
  const trackedReviewId = id(meta.review_id) ? meta.review_id : undefined;

  let emptyPending: { reusable: boolean } | undefined;
  let payload: LedgerPayload | undefined;
  if (trackedReviewId !== undefined) {
    const review = await github.review(work.repo, work.number, trackedReviewId);
    if (
      !object(review.user) ||
      !login(review.user.login) ||
      review.user.login.toLowerCase() !== bot
    ) {
      throw new Error("Tracked review was not authored by this bot account");
    }
    if (review.state === "PENDING") {
      if (typeof review.body !== "string" || review.body.trim() !== "") {
        throw new Error("Tracked pending review has content and cannot safely restore the ledger");
      }
      if ((await github.draftComments(work.repo, work.number, trackedReviewId)).length) {
        throw new Error("Tracked pending review has comments and cannot safely be reused");
      }
      emptyPending = { reusable: review.commit_id === work.head_sha };
    } else {
      try {
        payload = decodeBody(review.body, work.repo, work.number);
      } catch (error) {
        // The upgrade path for reviews predating durable payloads.
        if (!(error instanceof LedgerPayloadMissing)) throw error;
      }
      if (payload) {
        const summary = statusSummary(review.body);
        if (summary !== null) payload.status_summary = summary;
        const risk = riskAssessmentFromBody(review.body);
        if (risk !== null) payload.risk_assessment = risk;
      }
    }
  }
  if (!payload && pending && typeof pending.publication_body === "string") {
    try {
      const pendingLedger = decodeBody(pending.publication_body, work.repo, work.number);
      const pendingRisk = riskAssessmentFromBody(pending.publication_body);
      if (pendingLedger.head_sha === work.head_sha && pendingLedger.base_sha === work.base_sha) {
        payload = pendingLedger;
        const summary = statusSummary(pending.publication_body);
        if (summary !== null) payload.status_summary = summary;
        if (pendingRisk !== null) payload.risk_assessment = pendingRisk;
      }
    } catch (error) {
      if (!(error instanceof LedgerPayloadMissing)) throw error;
    }
  }
  if (payload && trackedReviewId === undefined) {
    // A payload restored only from a pending publication has no tracked
    // review for the restoration CLI to re-read. Python could start with the
    // decoded body; this port cannot hand that ledger to the runner, so the
    // work falls through to ledger-recovery consent instead (see README).
    payload = undefined;
  }
  if (payload) {
    work.ledger_restore = "runner";
    work.status_review_id = trackedReviewId;
    if (pendingMatches) {
      work.ledger_restore_pending = true;
    }
    work.update_count = payload.update_count;
    if (typeof payload.status_summary === "string") work.pr_summary = payload.status_summary;
    if (payload.risk_assessment) work.risk_assessment = payload.risk_assessment;
    if (emptyPending && !emptyPending.reusable) work.ignore_review_id = true;
    return "ready";
  }
  if (work.kind === "verify") return "missing";
  return emptyPending && !emptyPending.reusable ? "older-draft" : "missing";
}

/**
 * Classify one PR — the Python `candidate()` ladder. `inListing` mirrors the
 * data boundary Python had: the labeled listing carried author/draft fields,
 * while the unlabeled task scan (`gh pr view` state fields) did not, so the
 * author and draft gates apply only to listed PRs. `pendingRereview` is
 * Python's `pending_rereview` probe flag.
 */
function classify(
  repo: string,
  repoKey: string,
  pr: Pull,
  task: MemoryTask | undefined,
  options: { inListing: boolean; pendingRereview: boolean; bot: string },
): Candidate | undefined {
  const meta = metadata(task);
  const status = task?.status;
  if (task && (!status || !COMMANDABLE.has(status))) {
    if (status === "paused" || status === "archived") return undefined;
    throw new Error("Unknown review task status");
  }
  const author = pr.author.toLowerCase();
  if (
    options.inListing &&
    author !== "" &&
    author === options.bot &&
    author !== ALLOWED_SELF_AUTHOR
  )
    return undefined;
  if (options.inListing && pr.draft) {
    if (!(status === "done" && !meta.merged_at)) return undefined;
    return withWork("reconcile_open", 3);
  }
  if (RESUMABLE.has(status ?? "")) {
    if (meta.active_head_sha === pr.head && meta.active_base_sha === pr.base) {
      return withWork("resume", 0);
    }
    return withWork("review", 1);
  }
  if (meta.last_reviewed_sha !== pr.head || meta.last_reviewed_base_sha !== pr.base) {
    if (meta.last_verified_sha === pr.head && meta.last_verified_base_sha === pr.base) {
      return withWork("feedback_check", 2);
    }
    return withWork("review", 1);
  }
  if (timestamp(pr.updated) > timestamp(meta.last_seen_updated_at ?? EPOCH) || options.pendingRereview) {
    return withWork("feedback_check", 2);
  }
  if (status === "done" && !meta.merged_at) return withWork("reconcile_open", 3);
  return undefined;

  function withWork(kind: Kind, priority: number): Candidate {
    return {
      priority,
      status,
      listed: options.inListing,
      meta,
      pull: pr,
      work: {
        kind,
        task_key: `${PREFIX}${repo}#${pr.number}`,
        task_exists: task !== undefined,
        task_active: ACTIVE.has(status ?? ""),
        repo_key: repoKey,
        repo,
        number: pr.number,
        title: pr.title,
        url: pr.url,
        head_sha: pr.head,
        base_sha: pr.base,
        head_branch: pr.headBranch,
        pr_author: pr.author,
        updated_at: pr.updated,
      },
    };
  }
}

/** Lifecycle-only work for tasks whose PR left the labeled listing (Python `lifecycle_work`). */
function lifecycleWork(
  repo: string,
  repoKey: string,
  pr: Pull,
  task: MemoryTask | undefined,
): Candidate | undefined {
  const meta = metadata(task);
  const status = task?.status;
  if (status === "paused") return undefined;
  let kind: Kind;
  let priority = 0;
  let mergedAt: string | undefined;
  if (pr.merged) {
    kind = "merge_complete";
    mergedAt = pr.merged;
  } else if (pr.state === "closed") {
    kind = "closed_unmerged";
  } else if (pr.state === "open" && status === "done" && !meta.merged_at) {
    kind = "reconcile_open";
    priority = 3;
  } else {
    return undefined;
  }
  return {
    priority,
    status,
    listed: false,
    meta,
    pull: pr,
    work: {
      kind,
      task_key: `${PREFIX}${repo}#${pr.number}`,
      task_exists: task !== undefined,
      task_active: ACTIVE.has(status ?? ""),
      repo_key: repoKey,
      repo,
      number: pr.number,
      title: pr.title || task?.title || "",
      url: pr.url || `https://github.com/${repo}/pull/${pr.number}`,
      head_sha: pr.head,
      base_sha: pr.base,
      updated_at: pr.updated,
      ...(mergedAt !== undefined ? { merged_at: mergedAt } : {}),
    },
  };
}

export const fabricReviewQueue = definePreflight({
  id: ID,
  input,
  async run(
    ctx: PreflightRunContext,
    params: z.infer<typeof input>,
  ): Promise<PreflightExecutionResult> {
    try {
      if (!ctx.proxy) throw new Error("GitHub proxy is not wired");
      if (Object.keys(ctx.repos).length === 0) {
        throw new Error("No repositories in project-repos.json");
      }
      const github = reviewGitHub(
        typeof ctx.proxy === "string" ? { baseUrl: ctx.proxy } : ctx.proxy,
      );
      const repos = new Map<string, string>();
      const identities = new Set<string>();
      for (const [key, entry] of Object.entries(ctx.repos)) {
        const match = /^https:\/\/github\.com\/([a-z\d-]+)\/([a-z\d_.-]+)\/*$/i.exec(
          entry.upstream ?? "",
        );
        if (!match) continue;
        const name = match[2].replace(/\.git$/i, "");
        if (!name || name === "." || name === "..") continue;
        const repo = `${match[1]}/${name}`;
        if (identities.has(repo.toLowerCase()))
          throw new Error("Duplicate GitHub upstream in review config");
        identities.add(repo.toLowerCase());
        repos.set(repo, key);
      }
      return await select(ctx, params, github, repos);
    } catch (error) {
      return { status: "error", content: errorMessage(error) };
    }
  },
});

async function select(
  ctx: PreflightRunContext,
  params: z.infer<typeof input>,
  github: ReviewGitHub,
  repos: Map<string, string>,
): Promise<PreflightExecutionResult> {
  const memory = ctx.memory;
  const [bot, tasks] = await Promise.all([github.whoami(), memory.getAllTasks()]);
  if (bot !== params.bot_login.toLowerCase())
    throw new Error("GitHub proxy identity does not match the review bot");
  const label = params.review_label.toLowerCase();
  const member = memberCheck(github);
  const owned = new Map<string, MemoryTask>();
  for (const task of tasks) {
    if (
      task.source_type === "github" &&
      task.instance_id === ctx.instanceId &&
      task.external_key?.startsWith(PREFIX)
    ) {
      owned.set(task.external_key, task);
    }
  }
  let activeCount = [...owned.values()].filter((task) => ACTIVE.has(task.status ?? "")).length;
  const errors: string[] = [];
  const candidates: Candidate[] = [];
  const boundary: Candidate[] = [];
  const approvalWaits: string[] = [];
  const recoveryWaits: string[] = [];
  const verificationWaits: string[] = [];
  const issueCache = new Map<string, Promise<Comment[]>>();
  const issue = (work: Work) => {
    const pending =
      issueCache.get(work.task_key) ??
      github.issueComments(work.repo, work.number).then((rows) => comments(rows, "issue"));
    issueCache.set(work.task_key, pending);
    return pending;
  };

  /** Python `_inspect_labeled_pr` plus the unlabeled second-loop probe semantics. */
  async function inspect(candidate: Candidate): Promise<boolean> {
    const { work, meta, status } = candidate;
    let added = false;
    if (candidate.listed && work.kind !== "resume") {
      try {
        added = newerLabel(await github.events(work.repo, work.number), label, candidate);
      } catch (error) {
        // Lack of event proof cannot authorize a review. Existing SHA-change
        // work can still seek explicit approval.
        errors.push(`${work.repo}#${work.number}: cannot verify review-label event: ${errorMessage(error)}`);
      }
      if (added) {
        work.kind = "review";
        candidate.priority = 1;
        work.review_authorization = "label_added";
      }
    }
    if (!status || !COMMANDABLE.has(status)) {
      // Python: no task (or nothing commandable) means no comment scan; the
      // item is still found, with empty feedback ids, unless it is a
      // feedback_check with nothing to check.
      if (work.kind !== "feedback_check") work.feedback_comment_ids = [];
      return work.kind !== "feedback_check";
    }
    try {
      seen(meta.seen_feedback_comment_ids, string);
    } catch {
      throw new Error("Invalid seen_feedback_comment_ids");
    }
    const [top, inline, reviews] = await Promise.all([
      issue(work),
      github.inlineComments(work.repo, work.number),
      github.reviews(work.repo, work.number),
    ]);
    return await scanFeedback(
      candidate,
      [...top, ...comments(inline, "review-comment"), ...comments(reviews, "review")],
      bot,
      member,
      !candidate.listed,
      added,
    );
  }

  for (const [repo, repoKey] of repos) {
    let numbers: number[];
    try {
      numbers = await github.labeled(repo, params.review_label);
    } catch (error) {
      errors.push(`${repo}: ${errorMessage(error)}`);
      continue;
    }
    const listed = new Set(numbers);
    for (const key of owned.keys()) {
      if (!key.startsWith(`${PREFIX}${repo}#`)) continue;
      const number = Number(key.slice(`${PREFIX}${repo}#`.length));
      const task = owned.get(key);
      if (!listed.has(number) && id(number) && task?.status && COMMANDABLE.has(task.status))
        numbers.push(number);
    }
    for (const number of numbers) {
      const key = `${PREFIX}${repo}#${number}`;
      try {
        const cached = owned.get(key);
        // A key this instance owns is already in `owned`. Any other known task
        // for the key belongs to another instance (or an unattributed legacy
        // row) — never re-review work that is already tracked. The listing is
        // global, so this is the only cross-instance guard.
        if (!cached && (await memory.getTaskByKey(key, { sourceType: "github" }))) continue;
        const task = cached;
        if (task && (task.status === "paused" || task.status === "archived")) continue;
        const pr = await github.pr(repo, number);
        const meta = metadata(task);
        if (!listed.has(number)) {
          // Python's second loop: command probe first, then lifecycle work.
          if (pr.state === "closed") {
            const item = lifecycleWork(repo, repoKey, pr, task);
            if (item) candidates.push(item);
            continue;
          }
          const probe = classify(repo, repoKey, pr, task, {
            inListing: false,
            pendingRereview: true,
            bot,
          });
          if (!probe) continue;
          if (await inspect(probe)) {
            candidates.push(probe);
            continue;
          }
          const item = lifecycleWork(repo, repoKey, pr, task);
          if (item) candidates.push(item);
          continue;
        }
        const item = classify(repo, repoKey, pr, task, {
          inListing: true,
          pendingRereview: false,
          bot,
        });
        if (!item) {
          // Python's timestamp-boundary probe: a same-second command can share
          // the last-seen updatedAt and otherwise never enter feedback_check.
          if (task && (task.status === "done" || task.status === "pr_open") && meta.last_seen_updated_at) {
            const probe = classify(repo, repoKey, pr, task, {
              inListing: true,
              pendingRereview: true,
              bot,
            });
            if (probe?.work.kind === "feedback_check") boundary.push(probe);
          }
          continue;
        }
        if (await inspect(item)) candidates.push(item);
      } catch (error) {
        errors.push(`${repo}#${number}: ${errorMessage(error)}`);
      }
    }
  }

  const order = (a: Candidate, b: Candidate) =>
    a.priority - b.priority ||
    timestamp(a.pull.updated) - timestamp(b.pull.updated) ||
    (a.work.repo < b.work.repo ? -1 : a.work.repo > b.work.repo ? 1 : 0) ||
    a.work.number - b.work.number;

  /**
   * Process candidates in Python's `found.sort` order. Python re-picked one
   * candidate per pass and excluded consent waits; iterating the sorted list
   * with the same exclusion bookkeeping is equivalent. Hard failures of the
   * current candidate error the whole run, exactly like Python's
   * `output_result("error", …); return` paths. Consent waits (approval,
   * recovery, verification) only exclude that PR and keep scanning — Python
   * `main()`'s `excluded_task_keys` re-scan.
   */
  async function choose(items: Candidate[]): Promise<PreflightExecutionResult | undefined> {
    for (const candidate of items.sort(order)) {
      const { work } = candidate;
      if (work.kind === "review" && !work.task_active && activeCount >= CAPACITY_MAX) {
        return { status: "skip", content: `Review instance at task capacity (${activeCount}/${CAPACITY_MAX})` };
      }
      try {
        if (work.kind === "review" && work.review_authorization !== "label_added") {
          const state = await decision(candidate, "RA", github, await issue(work), bot, member);
          if (state !== "approved") {
            if (work.task_active) activeCount -= 1;
            approvalWaits.push(`${work.repo}#${work.number} (${state})`);
            continue;
          }
        }
        const restore = await restoration(candidate, github, bot);
        if (restore !== "ready") {
          // Recovery consent resets history and converts the work into a
          // fresh review — Python's restore_prior_ledger approval branch.
          if (work.kind !== "verify") {
            const top = await issue(work);
            const recovered = await decision(candidate, "LR", github, top, bot, member);
            if (recovered !== "approved") {
              if (work.task_active) activeCount -= 1;
              recoveryWaits.push(`${work.repo}#${work.number}`);
              continue;
            }
            work.kind = "review";
            work.update_count = 0;
            if (restore === "older-draft") work.ignore_review_id = true;
            work.feedback_comment_ids = (work.feedback_comment_ids ?? []).filter(
              (ident) => ident !== `issue:${work.ledger_recovery_response_comment_id}`,
            );
          } else {
            if (work.task_active) activeCount -= 1;
            verificationWaits.push(`${work.repo}#${work.number}`);
            continue;
          }
        }
        return { status: "start", content: JSON.stringify({ work, discovery_errors: errors }) };
      } catch (error) {
        return { status: "error", content: `${work.repo}#${work.number}: ${errorMessage(error)}` };
      }
    }
    return undefined;
  }

  const primary = await choose(candidates);
  if (primary) return primary;
  // Only probe timestamp-boundary comments when no higher-priority work is
  // ready. These requests are independently authorized by the runner.
  for (const candidate of boundary.sort(order)) {
    try {
      if (await inspect(candidate)) {
        const result = await choose([candidate]);
        if (result) return result;
      }
    } catch (error) {
      errors.push(`${candidate.work.repo}#${candidate.work.number}: ${errorMessage(error)}`);
    }
  }
  let detail = errors.length
    ? errors.join("; ")
    : "No labeled PR needs review or feedback handling";
  if (recoveryWaits.length) {
    detail = `Waiting for organization-member ledger-recovery decisions on ${recoveryWaits.join(", ")}; ${detail}`;
  }
  if (approvalWaits.length) {
    detail = `Waiting for organization-member review approvals on ${approvalWaits.join(", ")}; ${detail}`;
  }
  if (verificationWaits.length) {
    detail = `Verification commands need a recoverable prior ledger on ${verificationWaits.join(", ")}; ${detail}`;
  }
  return { status: errors.length ? "error" : "skip", content: detail };
}
