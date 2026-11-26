import { z } from "zod";
import { definePreflight } from "../../core/registry.js";
import type { PreflightRunContext } from "../../shared/run-context.js";
import { pyTruthy } from "../jira-common/shapes.js";
import { linkedIssues, planChanges, planDigest, planSnapshot } from "./plan.js";
import { createProjectReads, issueKey, readError } from "./reads.js";
import {
  COORD_STATES,
  field,
  fingerprint,
  humanComments,
  isAssigned,
  keyOf,
  labels,
  parentKey,
  pythonString,
  type RecordData,
  record,
  sorted,
  statusName,
  teamId,
  text,
} from "./snapshot.js";

const id = "fabric-project-state";
const jqlValue = z.string().regex(/^[A-Za-z0-9:_-]+$/);
const input = z.strictObject({
  project: jqlValue.default("RHCLOUD"),
  controlLabel: jqlValue,
  implementationLabel: jqlValue,
  teamFieldId: z.string().regex(/^customfield_\d+$/),
  // Retained for existing profiles; coordinator handoff no longer requires a sprint.
  includeBacklog: z.boolean().default(false),
});

const PHASE = /^phase:\d{2}$/;
const COMPLETE = new Set(["done", "closed", "resolved", "release pending"]);
const NOT_STARTED = new Set(["new", "backlog", "refinement", "to do"]);
const repoLabels = (items: string[]) => items.filter((label) => label.startsWith("repo:"));
const repoNames = (items: string[]) => new Set(repoLabels(items).map((label) => label.slice(5)));
const baseFields = ["summary", "description", "status"];

function requireFields(issue: RecordData, names: readonly string[]): void {
  const fields = record(issue.fields);
  for (const name of names) {
    if (!fields || !Object.hasOwn(fields, name))
      throw new Error(`Missing Jira field ${name} on ${issueKey(issue)}`);
  }
}

function summarizeChild(issue: RecordData, implementationLabel: string) {
  const items = labels(issue);
  const key = issueKey(issue);
  const status = statusName(issue);
  const assignee = field(issue, "assignee");
  if (!status || assignee === undefined)
    throw new Error(`Missing Jira status or assignee on ${key}`);
  const description = field(issue, "description");
  return {
    key,
    summary: text(field(issue, "summary")),
    status,
    phase_labels: sorted(items.filter((label) => PHASE.test(label))),
    repo_labels: sorted(repoLabels(items)),
    implementation_labeled: items.includes(implementationLabel),
    blockers: linkedIssues(issue).blockers,
    assignee: isAssigned(assignee),
    description: [...(pyTruthy(description) ? pythonString(description) : "")]
      .slice(0, 2000)
      .join(""),
  };
}

type Ticket = ReturnType<typeof summarizeChild>;

function cyclicDependencies(
  tickets: readonly Ticket[],
  byKey: ReadonlyMap<string, Ticket>,
): boolean {
  const pending = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  const ready: string[] = [];
  for (const ticket of tickets) {
    const internal = ticket.blockers.filter((key) => byKey.has(key));
    pending.set(ticket.key, internal.length);
    if (internal.length === 0) ready.push(ticket.key);
    for (const blocker of internal) {
      const children = dependents.get(blocker) ?? [];
      children.push(ticket.key);
      dependents.set(blocker, children);
    }
  }
  for (let i = 0; i < ready.length; i++) {
    for (const child of dependents.get(ready[i]) ?? []) {
      const count = (pending.get(child) ?? 0) - 1;
      pending.set(child, count);
      if (count === 0) ready.push(child);
    }
  }
  return ready.length !== tickets.length;
}

function assess(
  control: RecordData,
  children: readonly RecordData[],
  repoMap: PreflightRunContext["repos"],
  params: z.infer<typeof input>,
  team: string,
) {
  const controlLabels = labels(control);
  const state = controlLabels.filter((label) => COORD_STATES.has(label));
  const gaps: string[] = [];
  if (state.length > 1) gaps.push("Control ticket has multiple coordinator state labels");
  if (controlLabels.some((label) => PHASE.test(label)))
    gaps.push("Phase labels belong on implementation tickets, not the control ticket");
  if (controlLabels.includes(params.implementationLabel))
    gaps.push("Control ticket has the implementation bot label");
  const allowed = repoNames(controlLabels);
  if (!allowed.size) gaps.push("Control ticket needs one or more allowed repo: labels");
  const unknown = sorted([...allowed].filter((name) => !Object.hasOwn(repoMap, name)));
  if (unknown.length) gaps.push(`Control ticket has unknown repos: ${unknown.join(", ")}`);

  const tickets = children.map((issue) => summarizeChild(issue, params.implementationLabel));
  const byKey = new Map(tickets.map((ticket) => [ticket.key, ticket]));
  const phases = new Map<string, Ticket[]>();
  for (const ticket of tickets) {
    const phase = ticket.phase_labels[0];
    if (ticket.phase_labels.length === 0) gaps.push(`${ticket.key} has no phase label`);
    else if (ticket.phase_labels.length > 1) gaps.push(`${ticket.key} has multiple phase labels`);
    else {
      const phaseTickets = phases.get(phase) ?? [];
      phaseTickets.push(ticket);
      phases.set(phase, phaseTickets);
    }
  }
  if (!phases.has("phase:01")) gaps.push("No same-Team implementation ticket has phase:01");
  if (cyclicDependencies(tickets, byKey))
    gaps.push("Implementation ticket dependency links form a cycle");
  const complete = (ticket: Ticket) => COMPLETE.has(ticket.status.toLowerCase());
  const current = sorted(phases.keys()).find((phase) =>
    (phases.get(phase) ?? []).some((ticket) => !complete(ticket)),
  );

  const waiting: string[] = [];
  const blocked_tickets: { key: string; reasons: string[] }[] = [];
  const ready: { key: string; repo_candidates: string[] }[] = [];
  if (current && !gaps.length) {
    for (const ticket of phases.get(current) ?? []) {
      if (complete(ticket) || ticket.implementation_labeled) continue;
      if (
        ticket.blockers.some((key) => {
          const blocker = byKey.get(key);
          return !blocker || !complete(blocker);
        })
      ) {
        waiting.push(ticket.key);
        continue;
      }
      const repos = repoNames(ticket.repo_labels);
      const reasons: string[] = [];
      if ([...repos].some((name) => !allowed.has(name) || !Object.hasOwn(repoMap, name))) {
        reasons.push("repo label is outside the control ticket's allowlist");
      }
      if (!NOT_STARTED.has(ticket.status.toLowerCase()))
        reasons.push(`status ${ticket.status} is not not-started`);
      if (ticket.assignee) reasons.push("ticket is not unassigned");
      if (reasons.length) blocked_tickets.push({ key: ticket.key, reasons });
      else {
        ready.push({ key: ticket.key, repo_candidates: sorted(repos.size ? repos : allowed) });
      }
    }
  }
  if (!team) gaps.push("Control ticket has no Jira Team ID");
  if (children.some((child) => labels(child).includes(params.controlLabel))) {
    gaps.push("Parent has multiple same-Team control tickets");
  }
  return {
    state: state.length === 1 ? state[0] : null,
    allowed_repos: sorted(allowed),
    current_phase: current ?? null,
    gaps,
    ready: gaps.length ? [] : ready,
    waiting,
    blocked_tickets,
    tickets,
  };
}

export const fabricProjectState = definePreflight({
  id,
  input,
  async run(ctx: PreflightRunContext, params) {
    if (!ctx.proxy)
      return { status: "error", content: `${id}: Jira/GitHub proxy route is not wired` };
    let operation = "initialize gateway reads";
    try {
      const reads = createProjectReads(ctx.proxy);
      const { project, controlLabel, implementationLabel, teamFieldId } = params;
      operation = "search Jira controls";
      const candidates = await reads.search(
        `project = "${project}" AND labels = "${controlLabel}" ORDER BY key ASC`,
        ["key"],
      );
      const projects: RecordData[] = [];
      for (const candidate of candidates) {
        const controlKey = issueKey(candidate);
        operation = `read Jira control ${controlKey}`;
        const control = await reads.issue(controlKey, [
          ...baseFields,
          "parent",
          "labels",
          teamFieldId,
        ]);
        // The search index can lag a removed label. Do not enroll that issue.
        if (!labels(control).includes(controlLabel)) continue;
        requireFields(control, ["description"]);
        const team = teamId(control, teamFieldId);
        const parent = parentKey(control);
        const comments = humanComments(await reads.comments(controlKey));
        operation = `read coordinator task for ${controlKey}`;
        const task = await ctx.memory.getTaskByKey(controlKey, {
          scopeByInstance: true,
          sourceType: "jira",
        });
        if (task && task.instance_id !== ctx.instanceId)
          throw new Error("Memory returned a task outside this instance");
        const metadata = record(task?.metadata);
        if (task?.metadata != null && !metadata)
          throw new Error("Invalid coordinator task metadata");
        const previous = metadata?.snapshot_hash;
        if (previous != null && typeof previous !== "string")
          throw new Error("Invalid coordinator task snapshot hash");
        const identity = { control_key: controlKey, team_id: team, team_field_id: teamFieldId };
        if (!parent) {
          const snapshot_hash = fingerprint({}, control, [], teamFieldId, comments);
          if (previous !== snapshot_hash)
            projects.push({
              ...identity,
              snapshot_hash,
              error: "Control ticket has no parent issue",
            });
          continue;
        }

        operation = `read Jira parent and children for ${controlKey}`;
        if (!Object.keys(ctx.repos).length)
          throw new Error("Project repository map is unavailable");
        issueKey(parent);
        const parentIssue = await reads.issue(parent, baseFields);
        requireFields(parentIssue, ["description"]);
        const siblings = await reads.search(`parent = "${parent}" ORDER BY key ASC`, [
          ...baseFields,
          "parent",
          "labels",
          "issuelinks",
          "assignee",
          "updated",
          "priority",
          "issuetype",
          teamFieldId,
        ]);
        const children = siblings.filter((issue) => {
          if (!team || keyOf(issue) === controlKey || teamId(issue, teamFieldId) !== team)
            return false;
          const actualParent = parentKey(issue);
          if (!actualParent)
            throw new Error(`Missing parent field on Jira search result ${issueKey(issue)}`);
          return actualParent === parent;
        });
        for (const child of children)
          requireFields(child, ["updated", "description", "priority", "issuetype"]);
        const assessment = assess(control, children, ctx.repos, params, team);
        operation = `read GitHub PR snapshot for ${controlKey}`;
        const pullRequests = await reads.prSnapshot(children, implementationLabel, ctx.repos);
        const snapshot_hash = fingerprint(parentIssue, control, children, teamFieldId, comments, {
          tickets: pullRequests,
          errors: {},
        });
        const plan_snapshot = planSnapshot(children, teamFieldId);
        const plan_snapshot_hash = planDigest(plan_snapshot);
        const ticket_changes = planChanges(metadata?.plan_snapshot, plan_snapshot);
        const approved = metadata?.approved_plan_snapshot_hash;
        if (approved != null && typeof approved !== "string")
          throw new Error(`Invalid approved plan hash on task for ${controlKey}`);
        const approved_plan_snapshot_changed =
          typeof approved === "string" && approved !== plan_snapshot_hash;
        const plan_approval_pending = pyTruthy(metadata?.pending_plan_approval);
        const plan_change_required =
          plan_approval_pending ||
          approved_plan_snapshot_changed ||
          [ticket_changes.added, ticket_changes.removed, ticket_changes.changed].some(
            (items) => items.length > 0,
          );
        if (previous !== snapshot_hash || !assessment.state) {
          const processed = metadata?.processed_comment_ids;
          if (
            processed !== undefined &&
            processed !== null &&
            (!Array.isArray(processed) || processed.some((value) => typeof value !== "string"))
          ) {
            throw new Error(`Invalid processed comment IDs on task for ${controlKey}`);
          }
          const processedIds = new Set(Array.isArray(processed) ? processed : []);
          projects.push({
            ...identity,
            parent_key: parent,
            snapshot_hash,
            plan_snapshot,
            plan_snapshot_hash,
            approved_plan_snapshot_hash: approved ?? null,
            ticket_changes,
            approved_plan_snapshot_changed,
            plan_change_required,
            plan_approval_pending,
            first_run: !previous,
            new_comments: comments.filter(({ id }) => !processedIds.has(id)),
            open_pull_requests: pullRequests,
            github_pr_errors: {},
            ...assessment,
          });
        }
      }
      if (projects.length)
        return {
          status: "start",
          content: JSON.stringify({ projects, implementation_label: implementationLabel }),
        };
      return { status: "skip", content: `No changed ${project} control tickets` };
    } catch (error) {
      return { status: "error", content: `${id}: ${operation}: ${readError(error)}` };
    }
  },
});
