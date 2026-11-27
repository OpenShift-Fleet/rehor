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
  sha,
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
 * parses it unchanged. Deliberate deviations (all fail-closed gates or
 * documented transport replacements) are listed in the package README.
 */

const ID = "fabric-review-queue";
const PREFIX = "review-only:github:";
const EPOCH = "1970-01-01T00:00:00Z";
/** Python `REVIEWABLE_BOT_AUTHORS` — self-authored PRs this queue reviews. */
const ALLOWED_SELF_AUTHOR = "platex-rehor-bot";
const ACTIVE = new Set(ACTIVE_TASK_STATUSES);
const COMMANDABLE = new Set([...ACTIVE, "done"]);
const RESUMABLE = new Set(["in_progress", "pr_changes"]);
const LEDGER_PREFIX = "<!-- dev-review-bot:review-ledger:v1:";
const APPROVAL_NOTICE =
  "Approval is necessary but cannot start a review until revision continuity can be verified.";
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
  const cache = new Map<string, Promise<boolean>>();
  return (repo, user) => {
    const org = repo.split("/", 1)[0];
    const key = `${org.toLowerCase()}/${user}`;
    const pending = cache.get(key) ?? github.member(org, user);
    cache.set(key, pending);
    return pending;
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
    if (
      !c.original ||
      !within(c.created, since, Date.now()) ||
      seenFeedback.has(c.key) ||
      !(await member(work.repo, c.login))
    )
      continue;
    const request = parseCommandRequest(c, work.repo, work.number);
    if (!request) continue;
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

/**
 * Request and evaluate one organization-member decision (review approval or
 * ledger recovery), Python `_request_review_approval` /
 * `_request_ledger_recovery`. TS hardenings kept from earlier commits: the
 * request comment is rebound in place with PATCH (never duplicated), replies
 * must be strictly later than the request's last edit, edited or simultaneous
 * answers are ambiguous, and a `yes` cannot authorize dispatch until revision
 * continuity is provable (see the continuity gate in `choose`).
 */
async function decision(
  candidate: Candidate,
  mode: "RA" | "LR",
  github: ReviewGitHub,
  issue: Comment[],
  bot: string,
  member: Member,
  guard: () => Promise<void>,
  verifyOnly = false,
): Promise<ApprovalState> {
  const { work } = candidate;
  const key = decisionId(candidate, mode);
  const marker = `<!-- dev-review-bot:${mode === "RA" ? "review-approval" : "ledger-recovery"}:${key} -->`;
  // Approval IDs intentionally omit prior review state. Bind the comment itself
  // to that state so a label-authorized intervening review invalidates old replies.
  const contextMarker = `<!-- dev-review-bot:review-approval-context:v1:${createHash("sha256")
    .update(
      JSON.stringify([
        work.task_exists,
        candidate.status ?? null,
        ...[
          "last_reviewed_sha",
          "last_reviewed_base_sha",
          "last_reviewed_at",
          "active_head_sha",
          "active_base_sha",
          "review_id",
          "update_count",
        ].map((field) => candidate.meta[field] ?? null),
      ]),
    )
    .digest("hex")
    .slice(0, 16)} -->`;
  const requests = issue
    .filter(
      (c) =>
        c.login === bot &&
        Number.isFinite(c.created) &&
        (mode === "RA"
          ? /<!-- dev-review-bot:review-approval:RA-[0-9a-f]{12} -->/.test(c.body)
          : c.body.includes(marker)),
    )
    .sort(chronological);
  // Always use the earliest bot request, including when old duplicate comments exist.
  const request = requests[0];
  const rebind =
    mode === "RA" &&
    request &&
    (!request.body.includes(marker) ||
      !request.body.includes(contextMarker) ||
      !request.body.includes(APPROVAL_NOTICE) ||
      requests.slice(1).some((c) => c.updated >= request.updated));
  let reply: Comment | undefined;
  let yes = false;
  let ambiguous = false;
  let latestAt = Number.NEGATIVE_INFINITY;
  if (request && !rebind) {
    // Request IDs can recur after a revision reverts. GitHub timestamps have
    // second precision, so only replies strictly later than the latest edit
    // can prove they belong to this incarnation of the request.
    const pattern = new RegExp(`Review bot:\\s*(yes|no)\\s+${key}(?![A-Za-z0-9_-])`, "gi");
    for (const c of issue.filter((c) => c.user && c.login !== bot).sort(chronological)) {
      const matches = new Set([...c.body.matchAll(pattern)].map((match) => match[1].toLowerCase()));
      if (!matches.size) continue;
      const boundary = mode === "RA" ? request.updated : request.created;
      const at = c.original ? c.created : c.updated;
      if ((c.original ? at > boundary : at >= boundary) && (await member(work.repo, c.login))) {
        if (at < latestAt) continue;
        const simultaneous = at === latestAt;
        latestAt = at;
        reply = c;
        // An edited answer blocks consent until a strictly later clean answer.
        ambiguous = simultaneous || !c.original || matches.size !== 1;
        yes = !ambiguous && matches.has("yes");
      }
    }
  }
  // A yes cannot authorize dispatch until revision continuity is provable.
  const waiting = !reply || ambiguous || (mode === "RA" && yes);
  if (!verifyOnly && (mode === "RA" || !request)) {
    await guard();
    if (mode === "RA") await github.waitingLabel(work.repo, work.number, waiting);
  }
  if (!request || rebind) {
    if (verifyOnly) return "waiting";
    const reviewId = id(candidate.meta.review_id) ? candidate.meta.review_id : undefined;
    const link = reviewId
      ? `[View review status](https://github.com/${work.repo}/pull/${work.number}#pullrequestreview-${reviewId})`
      : "Pending the first review.";
    const requestBody =
      mode === "RA"
        ? `### Review approval required\n\n**Request:** \`${key}\`\n\n` +
          `**Reason:** ${work.rereview_comment_ids?.length ? "A re-review was requested without a new review-label event." : candidate.meta.last_reviewed_sha ? "The PR head or base changed since the last review." : "The configured review label has no new label-add event."}\n\n` +
          `**Target revision**\n- **Head:** \`${work.head_sha.slice(0, 12)}\`\n- **Base:** \`${work.base_sha.slice(0, 12)}\`\n\n` +
          `${APPROVAL_NOTICE}\n\n` +
          `**Reply with one option:**\n- \`Review bot: yes ${key}\` — approve this revision.\n- \`Review bot: no ${key}\` — decline the review.`
        : `### Review history needs recovery (${key})\n\n` +
          "The previous review ledger is unavailable. Starting over will reset the finding history and may assign new finding IDs.\n\n" +
          "Recovery cannot start until revision continuity can be verified.\n\n" +
          `An organization member can reply with \`Review bot: yes ${key}\` to approve or \`Review bot: no ${key}\` to decline.`;
    const body =
      `${requestBody}\n\n${marker}${mode === "RA" ? `\n${contextMarker}` : ""}\n\n` +
      `<!-- dev-review-bot:comment-footer:start -->\n---\n\n**Status Comment:** ${link}\n\n**Next steps:**\n` +
      "- Comment `/review-bot <question or request>` for an answer based on the pinned PR and review context.\n" +
      "<!-- dev-review-bot:comment-footer:end -->";
    if (rebind) await github.updateRequest(work.repo, request.id, body);
    else await github.postRequest(work.repo, work.number, body);
    return "waiting";
  }
  if (!reply || ambiguous) return "waiting";
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
    work.ledger_recovery_response_comment_id = reply.id;
    work.ledger_recovery_responder = reply.login;
  }
  return "approved";
}

type RestoreResult = "ready" | "missing" | "older-draft";

/**
 * Restore the prior review state for a start, Python `restore_prior_ledger`.
 * Decodes the same payloads with the same validation so `update_count`,
 * `pr_summary`, and `risk_assessment` carry Python's values. The Python
 * `work.ledger_path` file hand-off is replaced by `ledger_restore: "runner"`
 * (the dispatcher cannot write into the runner's sandbox); a legacy
 * `metadata.ledger_path` from the pre-migration runtime is not readable and
 * falls through to ledger recovery.
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
  if (meta.pending_publication !== undefined && meta.pending_publication !== null) {
    if (!object(meta.pending_publication)) throw new Error("Invalid pending review publication");
    pending = meta.pending_publication;
    if (
      pending.repo !== work.repo ||
      pending.pr !== work.number ||
      !sha(pending.head_sha) ||
      !sha(pending.base_sha) ||
      typeof pending.publication_body !== "string" ||
      !pending.publication_body.includes(LEDGER_PREFIX) ||
      !["review", "verify"].includes(String(pending.operation))
    ) {
      throw new Error("Cannot verify pending review publication reference");
    }
    if (
      (pending.head_sha !== work.head_sha || pending.base_sha !== work.base_sha) ||
      !id(meta.review_id)
    ) {
      throw new Error("Pending publication needs reconciliation before dispatch");
    }
  }
  if (meta.review_id !== undefined && meta.review_id !== null && !id(meta.review_id))
    throw new Error("Tracked review ID is invalid");

  let emptyPending: { reusable: boolean } | undefined;
  let payload: LedgerPayload | undefined;
  if (id(meta.review_id)) {
    const review = await github.review(work.repo, work.number, meta.review_id);
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
      if ((await github.draftComments(work.repo, work.number, meta.review_id)).length) {
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
  if (payload) {
    work.ledger_restore = "runner";
    if (pending?.head_sha === work.head_sha && pending?.base_sha === work.base_sha) {
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
   * `output_result("error", …); return` paths.
   */
  async function choose(items: Candidate[]): Promise<PreflightExecutionResult | undefined> {
    for (const candidate of items.sort(order)) {
      const { work, pull } = candidate;
      if (work.kind === "review" && !work.task_active && activeCount >= CAPACITY_MAX) {
        return { status: "skip", content: `Review instance at task capacity (${activeCount}/${CAPACITY_MAX})` };
      }
      if (work.kind === "resume") {
        // Legacy task metadata cannot prove whether the active pass was
        // authorized by a label, approval, or recovery for this incarnation.
        errors.push(`${work.repo}#${work.number}: cannot verify revision continuity for resume`);
        continue;
      }
      try {
        const guard = async () => {
          const live = await github.pr(work.repo, work.number);
          if (
            live.state !== "open" ||
            live.draft ||
            live.head !== pull.head ||
            live.base !== pull.base ||
            !live.labels.includes(label)
          )
            throw new Error("Review snapshot changed");
        };
        if (work.kind === "review" && work.review_authorization !== "label_added") {
          const state = await decision(candidate, "RA", github, await issue(work), bot, member, guard);
          if (state !== "approved") {
            if (work.task_active) activeCount -= 1;
            approvalWaits.push(`${work.repo}#${work.number} (${state})`);
            continue;
          }
        }
        const restore = await restoration(candidate, github, bot);
        if (
          work.ledger_restore_pending &&
          object(candidate.meta.pending_publication) &&
          candidate.meta.pending_publication.operation === "review"
        ) {
          // A pending review may have been prepared after recovery consent;
          // legacy publication metadata does not identify its authorization.
          errors.push(
            `${work.repo}#${work.number}: cannot verify revision continuity for pending review`,
          );
          continue;
        }
        if (restore !== "ready") {
          // Recovery consent resets history, but a current full-review grant
          // is still required before converting feedback/resume into a review.
          if (work.kind !== "verify") {
            const top = await issue(work);
            const recovered = await decision(candidate, "LR", github, top, bot, member, guard);
            if (recovered !== "approved") {
              if (work.task_active) activeCount -= 1;
              recoveryWaits.push(`${work.repo}#${work.number}`);
              continue;
            }
            if (work.review_authorization === undefined || work.review_authorization === null) {
              const state = await decision(candidate, "RA", github, top, bot, member, guard);
              if (state !== "approved") {
                if (work.task_active) activeCount -= 1;
                approvalWaits.push(`${work.repo}#${work.number} (${state})`);
                continue;
              }
            }
            work.kind = "review";
            work.update_count = 0;
            if (restore === "older-draft") work.ignore_review_id = true;
          } else {
            if (work.task_active) activeCount -= 1;
            verificationWaits.push(`${work.repo}#${work.number}`);
            continue;
          }
        }
        if (work.kind === "review") {
          await guard();
          const approval = work.review_authorization === "organization_member_approved";
          if (approval || work.ledger_recovery_approved) {
            const current = comments(await github.issueComments(work.repo, work.number), "issue");
            const freshMember = memberCheck(github);
            let valid = true;
            const failed: string[] = [];
            for (const mode of [
              ...(work.ledger_recovery_approved ? (["LR"] as const) : []),
              ...(approval ? (["RA"] as const) : []),
            ]) {
              if (
                (await decision(candidate, mode, github, current, bot, freshMember, guard, true)) !==
                "approved"
              ) {
                valid = false;
                failed.push(mode);
                break;
              }
            }
            if (!valid) {
              if (work.task_active) activeCount -= 1;
              for (const mode of failed)
                (mode === "RA" ? approvalWaits : recoveryWaits).push(`${work.repo}#${work.number}`);
              continue;
            }
            // Neither PR snapshots nor the currently available REST events prove
            // that head and base never changed and returned between polls.
            errors.push(`${work.repo}#${work.number}: cannot verify revision continuity`);
            continue;
          }
          await guard();
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
