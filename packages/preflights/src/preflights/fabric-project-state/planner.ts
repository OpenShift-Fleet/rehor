// Planner-owned plan routing for the Fabric project coordinator preflight,
// ported from project_coordinator.py at Fabric d62cc55 (planner-owned
// coordinator plans). The preflight answers one `PLANNER: /coord plan`
// control-ticket comment per run and short-circuits the scan with a planner
// route before any memory read or project assessment.
//
// RUNNER HANDOFF (coordinated with Fabric #191): upstream, the Python
// preflight writes data/planner-requests/<KEY>-<COMMENT>.json with
// {control_label, parent_key, docs_base, docs_glob} into a working directory
// shared with the workflow agent, and the sandbox planner reads it back. The
// Rehor dispatcher preflight cannot share that filesystem with the agent
// sandbox, so this port keeps only the legacy top-level payload
// {"planner": {control_key, comment_id, parent_key}} and performs no file
// write. The Fabric companion change makes the sandbox side self-sufficient:
// it binds the routed parent_key to a live Jira read (same staleness checks
// planner.py applies today) and derives the docs settings from trusted
// runner env (BOT_PLANNER_DOCS_*), so docs settings never travel through
// the start prompt.

import { planDigest, plannerTicketSnapshot } from "./plan.js";
import { issueKey } from "./reads.js";
import {
  type CommentRecord,
  keyOf,
  labels,
  parentKey,
  plannerCoordination,
  plannerFocus,
  plannerReceipt,
  type RecordData,
  record,
} from "./snapshot.js";

const PHASE = /^phase:\d{2}$/;
// Comment ids are positive decimals without a sign or leading zeros; control
// keys use the strict uppercase project shape planner_request_path enforces.
const COMMENT_ID = /^[1-9][0-9]*$/;
const CONTROL_KEY = /^[A-Z][A-Z0-9_]*-[1-9][0-9]*$/;

/** The newest planner assignment block and whether it covers current tickets. */
export type PlannerPlan = {
  comment_id: string | null;
  assignments: RecordData;
  current: boolean;
  input_snapshot_hash: unknown;
  current_snapshot_hash: string;
};

/** The planner route the workflow agent receives: one unanswered request. */
export type PlannerRequest = { control_key: string; comment_id: string; parent_key: string };

/**
 * project_coordinator.current_planner_plan: only the NEWEST planner receipt
 * counts, however invalid — an unreadable or stale newest block means the
 * coordinator must ask for a fresh plan, not fall back to an older one.
 */
export function currentPlannerPlan(
  comments: readonly CommentRecord[],
  children: readonly RecordData[],
  teamFieldId: string,
  repositoryNames: ReadonlySet<string>,
): PlannerPlan {
  const expected = new Set(children.map((issue) => issueKey(issue)));
  const currentHash = planDigest(plannerTicketSnapshot(children, teamFieldId));
  const stale = (comment: CommentRecord): PlannerPlan => ({
    comment_id: comment.id,
    assignments: {},
    current: false,
    input_snapshot_hash: null,
    current_snapshot_hash: currentHash,
  });
  for (const comment of [...comments].reverse()) {
    if (!plannerReceipt(comment)) continue;
    const proposal = plannerCoordination(comment);
    if (!proposal) return stale(comment);
    const assignments = record(proposal.ticket_assignments);
    const keys = assignments ? Object.keys(assignments) : [];
    let valid =
      assignments != null &&
      keys.length === expected.size &&
      keys.every((key) => expected.has(key)) &&
      proposal.input_snapshot_hash === currentHash;
    if (valid && assignments) {
      for (const assignment of Object.values(assignments)) {
        const item = record(assignment);
        if (
          !item ||
          !PHASE.test(String(item.phase ?? "")) ||
          !repositoryNames.has(item.repository as string)
        ) {
          valid = false;
          break;
        }
      }
    }
    return {
      comment_id: comment.id,
      assignments: assignments ?? {},
      current: valid,
      // Python dict.get emits null for a missing key; undefined here would
      // make JSON.stringify drop the field from the project payload.
      input_snapshot_hash: proposal.input_snapshot_hash ?? null,
      current_snapshot_hash: currentHash,
    };
  }
  return {
    comment_id: null,
    assignments: {},
    current: false,
    input_snapshot_hash: null,
    current_snapshot_hash: currentHash,
  };
}

/**
 * project_coordinator.pending_planner_request: the oldest PLANNER-routed
 * comment without a matching receipt wins. Key and comment-id shapes are
 * validated before routing so a malformed key fails closed like the Python's
 * planner_request_path instead of emitting an unusable route.
 */
export function pendingPlannerRequest(
  control: RecordData,
  comments: readonly CommentRecord[],
  controlLabel: string,
): PlannerRequest | null {
  const parent = parentKey(control);
  if (!parent || !labels(control).includes(controlLabel)) return null;
  const handled = new Set(
    comments
      .map((comment) => plannerReceipt(comment))
      .filter((receipt): receipt is string => receipt !== null),
  );
  for (const comment of comments) {
    if (!COMMENT_ID.test(comment.id) || handled.has(comment.id)) continue;
    if (plannerFocus(comment) === null) continue;
    const controlKey = keyOf(control);
    // planner_request_path validated both shapes before routing; the comment
    // id already passed COMMENT_ID above, so only the key can still fail.
    if (!CONTROL_KEY.test(controlKey))
      throw new Error("Invalid control ticket key or planner comment ID");
    return { control_key: controlKey, comment_id: comment.id, parent_key: parent };
  }
  return null;
}
