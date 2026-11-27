import { createHash } from "node:crypto";
import { pyTruthy } from "../jira-common/shapes.js";
import { mcpDescription, pyScalarStr, simplifyLinks } from "./mcp.js";
import { issueKey } from "./reads.js";
import {
  field,
  keyOf,
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

/**
 * Raw REST dependency links, used for execution gating only. This reads the
 * camelCase keys the REST API returns and fails closed on malformed entries,
 * so the coordinator keeps its real blocker/related checks even though the
 * hash-normalized plan snapshot cannot carry them (see mcpLinkedIssues).
 */
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

/**
 * project_coordinator.linked_issues() over the mcp-atlassian 0.23.1 link
 * shape: the server model renames inwardIssue/outwardIssue to snake_case, so
 * the Python camelCase reads find no counterpart and both sets stay empty.
 * The REST links are normalized through the same simplification first; the
 * extraction itself is ported verbatim so a later Fabric change to the
 * snake_case keys flips both sides consistently.
 */
export function mcpLinkedIssues(rawLinks: unknown): { blockers: string[]; related: string[] } {
  const simplified = simplifyLinks(rawLinks);
  const blockers = new Set<string>();
  const related = new Set<string>();
  for (const link of simplified) {
    // Python reads camelCase inwardIssue/outwardIssue keys, which the
    // simplified server shape never carries (it uses snake_case), so no link
    // is ever observed. Keep the camelCase reads verbatim to stay faithful.
    const linkType = record(link.type) ?? {};
    const name = text(linkType.name).toLowerCase();
    const inward = (link as RecordData).inwardIssue;
    const outward = (link as RecordData).outwardIssue;
    const other = keyOf(inward || outward);
    if (!other) continue;
    if (name.includes("relate")) related.add(other);
    if (inward && (name.includes("block") || text(linkType.inward).toLowerCase().includes("block")))
      blockers.add(other);
  }
  return { blockers: sorted(blockers), related: sorted(related) };
}

/** Python str(value or "") over an emulated MCP description value. */
export function descriptionText(emulated: unknown): string {
  if (emulated == null) return "";
  if (typeof emulated === "string") return emulated;
  return pythonString(emulated);
}

// JiraPriority.from_api_response/to_simplified_dict collapse the REST value
// to {"name": ...} with the model default "None"; falsy values are omitted
// from the tool response, which the Python reads back as an empty priority.
function mcpPriorityName(raw: unknown): string {
  if (!pyTruthy(raw)) return "";
  const obj = record(raw);
  if (!obj) return "None";
  return Object.hasOwn(obj, "name")
    ? pyScalarStr(obj.name as string | number | boolean | null)
    : "None";
}

// JiraIssueType.from_api_response/to_simplified_dict, same pattern with the
// model default "Unknown".
function mcpIssueTypeName(raw: unknown): string {
  if (!pyTruthy(raw)) return "";
  const obj = record(raw);
  if (!obj) return "Unknown";
  return Object.hasOwn(obj, "name")
    ? pyScalarStr(obj.name as string | number | boolean | null)
    : "Unknown";
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
    const issueType = pyTruthy(field(issue, "issuetype"))
      ? field(issue, "issuetype")
      : field(issue, "issue_type");
    snapshot[key] = {
      // The Fabric Python digests mcp-atlassian output, so every field below
      // is normalized through the same server transformation before hashing:
      // descriptions flatten via adf_to_text, the team field arrives wrapped
      // as {"value": processed} (teamId emulates that), priorities and issue
      // types collapse to their model name, and issue links are simplified
      // to the snake_case shape the Python extraction reads.
      summary: (pyTruthy(field(issue, "summary"))
        ? pythonString(field(issue, "summary"))
        : ""
      ).trim(),
      description: descriptionText(mcpDescription(field(issue, "description"))),
      priority: mcpPriorityName(field(issue, "priority")),
      issue_type: mcpIssueTypeName(issueType),
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
      ...mcpLinkedIssues(field(issue, "issuelinks")),
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
  return (
    oldUser.length === newUser.length && oldUser.every((label, index) => label === newUser[index])
  );
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
