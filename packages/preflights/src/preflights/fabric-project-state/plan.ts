import { createHash } from "node:crypto";
import { pyTruthy } from "../jira-common/shapes.js";
import { issueKey } from "./reads.js";
import {
  field,
  labels,
  pythonJson,
  pythonString,
  type RecordData,
  record,
  sorted,
  teamId,
  text,
} from "./snapshot.js";

const PHASE = /^phase:\d{2}$/;

export function linkedIssues(issue: RecordData): { blockers: string[]; related: string[] } {
  // Python reads `value(issue, "issuelinks") or []`: both the REST enhanced
  // search and the MCP issue model omit empty collections, so a missing or
  // null field means no links. Any other non-list value is malformed.
  const links = field(issue, "issuelinks");
  if (links == null) return { blockers: [], related: [] };
  if (!Array.isArray(links)) throw new Error(`Invalid Jira links on ${issueKey(issue)}`);
  const blockers = new Set<string>();
  const related = new Set<string>();
  for (const item of links) {
    const link = record(item);
    const type = record(link?.type);
    if (!link || !type) throw new Error(`Invalid Jira link on ${issueKey(issue)}`);
    const other = link.inwardIssue || link.outwardIssue;
    if (!other) continue;
    const key = issueKey(other);
    const name = text(type.name).toLowerCase();
    if (name.includes("relate")) related.add(key);
    if (
      link.inwardIssue &&
      (name.includes("block") || text(type.inward).toLowerCase().includes("block"))
    )
      blockers.add(key);
  }
  return { blockers: sorted(blockers), related: sorted(related) };
}

export function planSnapshot(
  children: readonly RecordData[],
  teamFieldId: string,
  implementationLabel: string,
): Record<string, RecordData> {
  const snapshot: Record<string, RecordData> = {};
  const byKey = new Map(children.map((issue) => [issueKey(issue), issue]));
  for (const key of sorted(byKey.keys())) {
    const issue = byKey.get(key);
    if (!issue) throw new Error(`Missing Jira issue ${key}`);
    const issueLabels = labels(issue);
    const priority = field(issue, "priority");
    const issueType = pyTruthy(field(issue, "issuetype"))
      ? field(issue, "issuetype")
      : field(issue, "issue_type");
    const priorityObj = record(priority);
    const typeObj = record(issueType);
    const asString = (value: unknown) => (pyTruthy(value) ? pythonString(value) : "");
    snapshot[key] = {
      summary: asString(field(issue, "summary")).trim(),
      description: asString(field(issue, "description")),
      priority: priorityObj ? asString(priorityObj.name || priorityObj.id) : asString(priority),
      issue_type: typeObj ? asString(typeObj.name) : asString(issueType),
      team_id: teamId(issue, teamFieldId),
      phase_labels: sorted(issueLabels.filter((label) => PHASE.test(label))),
      repo_labels: sorted(issueLabels.filter((label) => label.startsWith("repo:"))),
      planning_labels: sorted(
        issueLabels.filter(
          (label) =>
            !PHASE.test(label) &&
            !label.startsWith("repo:") &&
            !label.startsWith("dev-bot-coordinator:") &&
            label !== implementationLabel,
        ),
      ),
      ...linkedIssues(issue),
    };
  }
  return snapshot;
}

export function planDigest(snapshot: Record<string, RecordData>): string {
  return createHash("sha256").update(pythonJson(snapshot)).digest("hex");
}

// Python compares only these fields, in this (sorted) order; older snapshots
// that carried runtime fields (updated, status, assignee, labels) are ignored
// for change detection because ordinary execution progress must not force a
// plan reapproval.
const PLAN_FIELDS = [
  "blockers",
  "description",
  "issue_type",
  "phase_labels",
  "planning_labels",
  "priority",
  "related",
  "repo_labels",
  "summary",
  "team_id",
] as const;

// Older task snapshots included the implementation bot label in
// planning_labels. Ignore that difference during the one-time snapshot
// format transition.
function legacyPlanningLabelsOnly(
  before: RecordData,
  after: RecordData,
  implementationLabel: string,
): boolean {
  const oldLabels = before.planning_labels;
  const newLabels = after.planning_labels;
  if (!Array.isArray(oldLabels) || !Array.isArray(newLabels)) return false;
  const userLabels = (items: unknown[]): string[] => {
    if (items.some((item) => typeof item !== "string"))
      throw new Error("Invalid stored planning labels");
    return sorted(items.filter((label): label is string => label !== implementationLabel));
  };
  const oldUser = userLabels(oldLabels);
  const newUser = userLabels(newLabels);
  return oldUser.length === newUser.length && oldUser.every((label, index) => label === newUser[index]);
}

export function planChanges(
  previous: unknown,
  current: Record<string, RecordData>,
  implementationLabel: string,
) {
  const old = record(previous);
  if (!old) return { baseline_missing: true, added: [], removed: [], changed: [] };
  const oldKeys = new Set(Object.keys(old));
  const newKeys = new Set(Object.keys(current));
  const added = sorted([...newKeys].filter((key) => !oldKeys.has(key))).map((key) => ({
    key,
    ticket: current[key],
  }));
  const removed = sorted([...oldKeys].filter((key) => !newKeys.has(key))).map((key) => ({
    key,
    ticket: old[key],
  }));
  const changed = sorted([...oldKeys].filter((key) => newKeys.has(key))).flatMap((key) => {
    const before = record(old[key]);
    const after = current[key];
    if (!before) return [{ key, fields: { ticket: { before: old[key], after } } }];
    const fields: Record<string, { before: unknown; after: unknown }> = {};
    for (const field of PLAN_FIELDS) {
      const prior = before[field] ?? null;
      const next = after[field] ?? null;
      if (pythonJson(prior) !== pythonJson(next)) fields[field] = { before: prior, after: next };
    }
    if (legacyPlanningLabelsOnly(before, after, implementationLabel)) delete fields.planning_labels;
    return Object.keys(fields).length ? [{ key, fields }] : [];
  });
  return { baseline_missing: false, added, removed, changed };
}
