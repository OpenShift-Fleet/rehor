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

const ID = "fabric-review-queue";
const PREFIX = "review-only:github:";
const EPOCH = "1970-01-01T00:00:00Z";
const ALLOWED_SELF_AUTHOR = "platex-rehor-bot";
const ACTIVE = new Set(ACTIVE_TASK_STATUSES);
const COMMANDABLE = new Set([...ACTIVE, "done"]);
const RESUMABLE = new Set(["in_progress", "pr_changes"]);
const LEDGER_PREFIX = "<!-- dev-review-bot:review-ledger:v1:";
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
interface Work {
  kind: Kind;
  repo_key: string;
  repo: string;
  number: number;
  task_key: string;
  task_exists: boolean;
  task_active: boolean;
  task_status?: string;
  head_sha: string;
  base_sha: string;
  updated_at: string;
  merged_at?: string;
  status_review_id?: number;
  review_label_event_id?: number;
  review_authorization?: "label_added" | "organization_member_approved";
  review_approval_id?: string;
  review_approval_response_comment_id?: number;
  review_approval_responder?: string;
  verify_comment_ids?: number[];
  rereview_comment_ids?: number[];
  feedback_comment_ids?: string[];
  command_requests?: { source: Source; id: number; feedback_id: string }[];
  ledger_restore?: "runner";
  ledger_restore_pending?: true;
  ledger_recovery_approved?: true;
  ledger_recovery_state?: "approved";
  ledger_recovery_response_comment_id?: number;
  ledger_recovery_responder?: string;
  ignore_review_id?: true;
  update_count?: 0;
}
interface Candidate {
  priority: number;
  work: Work;
  pull: Pull;
  listed: boolean;
  meta: RecordData;
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
  user: boolean;
  body: string;
  created: number;
  updated: number;
  hasUpdatedTimestamp: boolean;
  original: boolean;
}
function comments(rows: RecordData[], source: Source): Comment[] {
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
        user: row.user.type === "User",
        body: row.body,
        created,
        updated,
        hasUpdatedTimestamp: Number.isFinite(timestamp(row.updated_at)),
        original:
          source === "review" ? row.state !== "DISMISSED" : row.created_at === row.updated_at,
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
const within = (value: number, since: number, through: number) =>
  since <= value && value <= through;
const explicit = (c: Comment) =>
  c.source === "issue" && /^\/review-bot\s+(?:verify|re-review)$/i.test(c.body.trim());

async function scanFeedback(
  candidate: Candidate,
  all: Comment[],
  bot: string,
  member: Member,
  contextOnly: boolean,
  labelAdded: boolean,
): Promise<boolean> {
  const { work, meta } = candidate;
  const since = timestamp(meta.last_seen_updated_at || meta.last_reviewed_at || EPOCH);
  const through = timestamp(work.updated_at);
  if (!Number.isFinite(since) || since > through) throw new Error("Invalid review task watermark");
  const seenFeedback = seen(meta.seen_feedback_comment_ids, string);
  const humans = [
    ...new Map(all.filter((c) => c.user && c.login !== bot).map((c) => [c.key, c])).values(),
  ];
  const requests: NonNullable<Work["command_requests"]> = [];
  for (const c of [...humans].sort(
    (a, b) => a.created - b.created || a.source.localeCompare(b.source) || a.id - b.id,
  )) {
    if (
      c.original &&
      within(c.created, since, Date.now()) &&
      !seenFeedback.has(c.key) &&
      /^\/review-bot(?:\s|$)/i.test(c.body.trimStart()) &&
      !explicit(c) &&
      (await member(work.repo, c.login))
    ) {
      requests.push({ source: c.source, id: c.id, feedback_id: c.key });
      if (requests.length === 5) break;
    }
  }
  if (requests.length) {
    work.kind = "command_reply";
    candidate.priority = 1;
    work.command_requests = requests;
    work.feedback_comment_ids = requests.map((request) => request.feedback_id);
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
    work.task_status === "pr_open" &&
    id(meta.review_id) &&
    (meta.last_reviewed_sha || meta.update_count)
  ) {
    const ids = await exact("verify", meta.seen_verify_comment_ids);
    if (ids.length) {
      work.kind = "verify";
      candidate.priority = 1;
      work.verify_comment_ids = ids;
      return true;
    }
  }
  if (work.kind !== "resume") {
    const ids = await exact("re-review", meta.seen_rereview_comment_ids);
    if (ids.length) {
      work.kind = "review";
      candidate.priority = 1;
      work.rereview_comment_ids = ids;
      // A verified command asks for a review; only a fresh label or a separate decision authorizes it.
    }
  }
  if (work.kind === "review" || work.kind === "feedback_check") {
    const feedback: string[] = [];
    for (const c of humans) {
      if (
        within(c.updated, since, through) &&
        !seenFeedback.has(c.key) &&
        !explicit(c) &&
        !(
          c.source === "issue" && /Review bot:\s*(?:yes|no)\s+(?:RA|LR)-[a-f\d]{12}\b/i.test(c.body)
        ) &&
        (await member(work.repo, c.login))
      )
        feedback.push(c.key);
    }
    work.feedback_comment_ids = feedback;
    if (work.kind === "feedback_check" && !feedback.length) return false;
  }
  return true;
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

async function decision(
  candidate: Candidate,
  mode: "RA" | "LR",
  github: ReviewGitHub,
  issue: Comment[],
  bot: string,
  member: Member,
  guard: () => Promise<void>,
  verifyOnly = false,
): Promise<boolean> {
  const { work } = candidate;
  const key = decisionId(candidate, mode);
  const marker = `<!-- dev-review-bot:${mode === "RA" ? "review-approval" : "ledger-recovery"}:${key} -->`;
  // Approval IDs intentionally omit prior review state. Bind the comment itself
  // to that state so a label-authorized intervening review invalidates old replies.
  const contextMarker = `<!-- dev-review-bot:review-approval-context:v1:${createHash("sha256")
    .update(
      JSON.stringify([
        work.task_exists,
        work.task_status ?? null,
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
  if (mode === "RA" && requests.some((c) => !c.hasUpdatedTimestamp || c.updated < c.created))
    throw new Error("Cannot verify approval request update time");
  const rebind =
    mode === "RA" &&
    request &&
    (!request.body.includes(marker) ||
      !request.body.includes(contextMarker) ||
      requests.slice(1).some((c) => c.updated >= request.updated));
  let reply: Comment | undefined;
  let yes = false;
  if (request && !rebind) {
    // Request IDs can recur after a revision reverts. GitHub timestamps have
    // second precision, so only replies strictly later than the latest edit
    // can prove they belong to this incarnation of the request.
    const pattern = new RegExp(`Review bot:\\s*(yes|no)\\s+${key}(?![A-Za-z0-9_-])`, "gi");
    for (const c of issue
      .filter(
        (c) =>
          c.user &&
          c.login !== bot &&
          Number.isFinite(c.created) &&
          (mode === "RA" ? c.created > request.updated : chronological(c, request) > 0),
      )
      .sort(chronological)) {
      const matches = new Set([...c.body.matchAll(pattern)].map((match) => match[1].toLowerCase()));
      if (matches.size === 1 && (await member(work.repo, c.login))) {
        reply = c;
        yes = matches.has("yes");
      }
    }
  }
  const waiting = !reply;
  if (!verifyOnly && (mode === "RA" || !request)) {
    await guard();
    if (mode === "RA") await github.waitingLabel(work.repo, work.number, waiting);
  }
  if (!request || rebind) {
    if (verifyOnly) return false;
    const link = work.status_review_id
      ? `[View review status](https://github.com/${work.repo}/pull/${work.number}#pullrequestreview-${work.status_review_id})`
      : "Pending the first review.";
    const requestBody =
      mode === "RA"
        ? `### Review approval required\n\n**Request:** \`${key}\`\n\n` +
          `**Reason:** ${work.rereview_comment_ids?.length ? "A re-review was requested without a new review-label event." : candidate.meta.last_reviewed_sha ? "The PR head or base changed since the last review." : "The configured review label has no new label-add event."}\n\n` +
          `**Target revision**\n- **Head:** \`${work.head_sha.slice(0, 12)}\`\n- **Base:** \`${work.base_sha.slice(0, 12)}\`\n\n` +
          "No review will run until an organization member approves this exact revision.\n\n" +
          `**Reply with one option:**\n- \`Review bot: yes ${key}\` — approve and start the review.\n- \`Review bot: no ${key}\` — decline the review.`
        : `### Review history needs recovery (${key})\n\n` +
          "The previous review ledger is unavailable. Starting over will reset the finding history and may assign new finding IDs.\n\n" +
          `An organization member can reply with \`Review bot: yes ${key}\` to approve or \`Review bot: no ${key}\` to decline.`;
    const body =
      `${requestBody}\n\n${marker}${mode === "RA" ? `\n${contextMarker}` : ""}\n\n` +
      `<!-- dev-review-bot:comment-footer:start -->\n---\n\n**Status Comment:** ${link}\n\n**Next steps:**\n` +
      "- Comment `/review-bot <question or request>` for an answer based on the pinned PR and review context.\n" +
      "<!-- dev-review-bot:comment-footer:end -->";
    if (rebind) await github.updateRequest(work.repo, request.id, body);
    else await github.postRequest(work.repo, work.number, body);
  }
  if (!reply || !yes) return false;
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
  return true;
}

async function restoration(
  candidate: Candidate,
  github: ReviewGitHub,
  bot: string,
): Promise<"ready" | "missing" | "older-draft"> {
  const { work, meta } = candidate;
  if (!["review", "resume", "feedback_check", "verify"].includes(work.kind)) return "ready";
  if (
    meta.pending_publication !== undefined &&
    meta.pending_publication !== null &&
    !object(meta.pending_publication)
  ) {
    throw new Error("Invalid pending review publication");
  }
  const pending = object(meta.pending_publication) ? meta.pending_publication : undefined;
  if (
    pending &&
    (pending.repo !== work.repo ||
      pending.pr !== work.number ||
      !sha(pending.head_sha) ||
      !sha(pending.base_sha) ||
      typeof pending.publication_body !== "string" ||
      !pending.publication_body.includes(LEDGER_PREFIX) ||
      !["review", "verify"].includes(String(pending.operation)))
  ) {
    throw new Error("Cannot verify pending review publication reference");
  }
  const matchingPending = pending?.head_sha === work.head_sha && pending.base_sha === work.base_sha;
  if (pending && (!matchingPending || !work.status_review_id)) {
    throw new Error("Pending publication needs reconciliation before dispatch");
  }
  const historical = Boolean(
    meta.review_id ||
      meta.last_reviewed_sha ||
      meta.update_count ||
      work.task_status === "pr_open" ||
      work.task_status === "pr_changes",
  );
  if (meta.review_id !== undefined && meta.review_id !== null && !id(meta.review_id))
    throw new Error("Invalid tracked review ID");
  let olderDraft = false;
  if (work.status_review_id) {
    const review = await github.review(work.repo, work.number, work.status_review_id);
    if (
      review.id !== work.status_review_id ||
      !object(review.user) ||
      !login(review.user.login) ||
      review.user.login.toLowerCase() !== bot ||
      typeof review.body !== "string" ||
      !["PENDING", "COMMENTED", "DISMISSED"].includes(String(review.state))
    ) {
      throw new Error("Tracked status review cannot be verified");
    }
    if (review.state === "PENDING") {
      if (
        review.body.trim() ||
        !sha(review.commit_id) ||
        (await github.draftComments(work.repo, work.number, work.status_review_id)).length
      ) {
        throw new Error("Tracked draft needs manual reconciliation");
      }
      olderDraft = review.commit_id !== work.head_sha;
    } else if (review.body.includes(LEDGER_PREFIX)) {
      // The runner validates exact v1 decoding, revision, findings and risk. A malformed
      // marker must never silently become a fresh review.
      work.ledger_restore = "runner";
      if (matchingPending) work.ledger_restore_pending = true;
      return "ready";
    }
  }
  if (matchingPending && !olderDraft) {
    work.ledger_restore = "runner";
    work.ledger_restore_pending = true;
    return "ready";
  }
  if (pending) {
    throw new Error("Tracked draft needs reconciliation before dispatch");
  }
  if (!historical && work.kind !== "verify") {
    work.update_count = 0;
    return "ready";
  }
  return olderDraft ? "older-draft" : "missing";
}

function classify(
  repo: string,
  repoKey: string,
  pr: Pull,
  task: MemoryTask | undefined,
  listed: boolean,
  bot: string,
): Candidate | undefined {
  const meta = metadata(task);
  const status = task?.status;
  if (task && (!status || !COMMANDABLE.has(status))) {
    if (status === "paused" || status === "archived") return undefined;
    throw new Error("Unknown review task status");
  }
  const active = ACTIVE.has(status ?? "");
  let kind: Kind;
  let priority: number;
  if (pr.state === "closed") {
    if (!COMMANDABLE.has(status ?? "")) return undefined;
    kind = pr.merged ? "merge_complete" : "closed_unmerged";
    priority = 0;
  } else if (!listed) {
    if (
      !pr.draft &&
      (pr.author !== bot || bot === ALLOWED_SELF_AUTHOR) &&
      COMMANDABLE.has(status ?? "")
    ) {
      // Unlabeled tracked PRs still accept contextual commands, not full reviews.
      kind = "feedback_check";
      priority = 4;
    } else if (status === "done" && !meta.merged_at) {
      kind = "reconcile_open";
      priority = 3;
    } else return undefined;
  } else if (
    RESUMABLE.has(status ?? "") &&
    meta.active_head_sha === pr.head &&
    meta.active_base_sha === pr.base
  ) {
    kind = "resume";
    priority = 0;
  } else if (
    RESUMABLE.has(status ?? "") ||
    ((meta.last_reviewed_sha !== pr.head || meta.last_reviewed_base_sha !== pr.base) &&
      (meta.last_verified_sha !== pr.head || meta.last_verified_base_sha !== pr.base))
  ) {
    kind = "review";
    priority = 1;
  } else {
    kind = "feedback_check";
    priority = timestamp(pr.updated) > timestamp(meta.last_seen_updated_at ?? EPOCH) ? 2 : 4;
  }
  return {
    priority,
    listed,
    pull: pr,
    meta,
    work: {
      kind,
      repo_key: repoKey,
      repo,
      number: pr.number,
      task_key: `${PREFIX}${repo}#${pr.number}`,
      task_exists: task !== undefined,
      task_active: active,
      task_status: status,
      head_sha: pr.head,
      base_sha: pr.base,
      updated_at: pr.updated,
      ...(pr.merged ? { merged_at: pr.merged } : {}),
      ...(id(meta.review_id) ? { status_review_id: meta.review_id } : {}),
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
      if (!repos.size) throw new Error("No GitHub upstreams in project-repos.json");
      return await select(ctx, params, github, repos);
    } catch {
      return {
        status: "error",
        content: `${ID}: cannot verify queue configuration, repository access, or task state`,
      };
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
  const active = [...owned.values()].filter((task) => ACTIVE.has(task.status ?? "")).length;
  const errors: string[] = [];
  const candidates: Candidate[] = [];
  const boundary: Candidate[] = [];
  const issueCache = new Map<string, Promise<Comment[]>>();
  const issue = (work: Work) => {
    const pending =
      issueCache.get(work.task_key) ??
      github.issueComments(work.repo, work.number).then((rows) => comments(rows, "issue"));
    issueCache.set(work.task_key, pending);
    return pending;
  };
  async function inspect(candidate: Candidate): Promise<boolean> {
    const { work, listed } = candidate;
    let added = false;
    if (listed && work.kind !== "resume") {
      try {
        added = newerLabel(await github.events(work.repo, work.number), label, candidate);
      } catch {
        // Lack of event proof cannot authorize a review. Existing SHA-change
        // work can still seek explicit approval.
        errors.push(`${work.repo}#${work.number}: label event unavailable`);
      }
      if (added) {
        work.kind = "review";
        candidate.priority = 1;
        work.review_authorization = "label_added";
      }
    }
    if (work.task_status && COMMANDABLE.has(work.task_status)) {
      const [top, inline, reviews] = await Promise.all([
        issue(work),
        github.inlineComments(work.repo, work.number),
        github.reviews(work.repo, work.number),
      ]);
      const actionable = await scanFeedback(
        candidate,
        [...top, ...comments(inline, "review-comment"), ...comments(reviews, "review")],
        bot,
        member,
        !listed,
        added,
      );
      if (actionable) return true;
      if (work.task_status === "done" && !candidate.meta.merged_at) {
        work.kind = "reconcile_open";
        candidate.priority = 3;
        return true;
      }
      return false;
    }
    return work.kind !== "feedback_check";
  }

  for (const [repo, repoKey] of repos) {
    let numbers: number[];
    try {
      numbers = await github.labeled(repo, params.review_label);
    } catch {
      errors.push(`${repo}: labeled PR listing unavailable`);
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
        const eligibleLabel =
          listed.has(number) &&
          pr.labels.includes(label) &&
          !pr.draft &&
          (pr.author !== bot || bot === ALLOWED_SELF_AUTHOR);
        const candidate = classify(repo, repoKey, pr, task, eligibleLabel, bot);
        if (!candidate) continue;
        if (["merge_complete", "closed_unmerged", "reconcile_open"].includes(candidate.work.kind))
          candidates.push(candidate);
        else if (candidate.priority === 4 && eligibleLabel) boundary.push(candidate);
        else if (await inspect(candidate)) candidates.push(candidate);
      } catch {
        errors.push(`${repo}#${number}: cannot verify review eligibility`);
      }
    }
  }

  const order = (a: Candidate, b: Candidate) =>
    a.priority - b.priority ||
    timestamp(a.pull.updated) - timestamp(b.pull.updated) ||
    a.work.repo.localeCompare(b.work.repo) ||
    a.work.number - b.work.number;
  let waiting = 0;
  async function choose(items: Candidate[]): Promise<PreflightExecutionResult | undefined> {
    for (const candidate of items.sort(order)) {
      const { work, pull } = candidate;
      if (work.kind === "review" && !work.task_active && active >= 10) {
        return { status: "skip", content: `${ID}: review task capacity reached (${active}/10)` };
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
        if (
          work.kind === "review" &&
          !work.review_authorization &&
          !(await decision(candidate, "RA", github, await issue(work), bot, member, guard))
        ) {
          waiting += 1;
          continue;
        }
        const restore = await restoration(candidate, github, bot);
        if (restore !== "ready") {
          // Recovery consent resets history, but a current full-review grant
          // is still required before converting feedback/resume into a review.
          if (work.kind !== "verify") {
            const top = await issue(work);
            await decision(candidate, "LR", github, top, bot, member, guard);
            if (
              work.ledger_recovery_approved &&
              !work.review_authorization &&
              !(await decision(candidate, "RA", github, top, bot, member, guard))
            ) {
              waiting += 1;
              continue;
            }
          }
          if (!work.ledger_recovery_approved) {
            waiting += 1;
            continue;
          }
          work.kind = "review";
          work.update_count = 0;
          if (restore === "older-draft") work.ignore_review_id = true;
        }
        if (work.kind === "review") {
          await guard();
          if (
            work.review_authorization === "organization_member_approved" &&
            !(await decision(
              candidate,
              "RA",
              github,
              comments(await github.issueComments(work.repo, work.number), "issue"),
              bot,
              member,
              guard,
              true,
            ))
          ) {
            waiting += 1;
            continue;
          }
          await guard();
        }
        return { status: "start", content: JSON.stringify({ work, discovery_errors: errors }) };
      } catch {
        errors.push(
          `${work.repo}#${work.number}: authorization or restoration prerequisites unavailable`,
        );
      }
    }
    return undefined;
  }

  const primary = await choose(candidates);
  if (primary) return primary;
  for (const candidate of boundary.sort(order)) {
    try {
      if (await inspect(candidate)) {
        const result = await choose([candidate]);
        if (result) return result;
      }
    } catch {
      errors.push(`${candidate.work.repo}#${candidate.work.number}: boundary feedback unavailable`);
    }
  }
  if (errors.length) return { status: "error", content: `${ID}: ${errors.join("; ")}` };
  return {
    status: "skip",
    content: waiting
      ? `${ID}: waiting for review approval or ledger recovery on ${waiting} PR(s)`
      : `${ID}: no eligible review work`,
  };
}
