import { createHash } from "node:crypto";
import { pyTruthy } from "../jira-common/shapes.js";
import { issueKey } from "./reads.js";
import {
  field,
  isAssigned,
  labels,
  pythonJson,
  pythonString,
  type RecordData,
  record,
  sorted,
  statusName,
  teamId,
  text,
} from "./snapshot.js";

const PHASE = /^phase:\d{2}$/;

export function linkedIssues(issue: RecordData): { blockers: string[]; related: string[] } {
  const links = field(issue, "issuelinks");
  if (!Array.isArray(links)) throw new Error(`Missing or invalid Jira links on ${issueKey(issue)}`);
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
      updated: asString(field(issue, "updated")),
      status: statusName(issue),
      assignee: isAssigned(field(issue, "assignee")),
      priority: priorityObj ? asString(priorityObj.name || priorityObj.id) : asString(priority),
      issue_type: typeObj ? asString(typeObj.name) : asString(issueType),
      team_id: teamId(issue, teamFieldId),
      labels: sorted(issueLabels),
      phase_labels: sorted(issueLabels.filter((label) => PHASE.test(label))),
      repo_labels: sorted(issueLabels.filter((label) => label.startsWith("repo:"))),
      planning_labels: sorted(
        issueLabels.filter(
          (label) =>
            !PHASE.test(label) &&
            !label.startsWith("repo:") &&
            !label.startsWith("dev-bot-coordinator:"),
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

export function planChanges(previous: unknown, current: Record<string, RecordData>) {
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
    for (const field of sorted(new Set([...Object.keys(before), ...Object.keys(after)]))) {
      const prior = before[field] ?? null;
      const next = after[field] ?? null;
      if (pythonJson(prior) !== pythonJson(next)) fields[field] = { before: prior, after: next };
    }
    return Object.keys(fields).length ? [{ key, fields }] : [];
  });
  return { baseline_missing: false, added, removed, changed };
}
