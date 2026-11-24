import { z } from "zod";
import { definePreflight } from "../../core/registry.js";
import type { PreflightExecutionResult } from "../../core/results.js";
import {
  appendFetchEvidence,
  FetchTracker,
  totalFetchFailureError,
} from "../../shared/failure-policy.js";
import type { GhOpenPr, GitHubClient } from "../../shared/github.js";
import { createGitHubClient } from "../../shared/github.js";
import type { MemoryServerClient, MemoryTask } from "../../shared/memory-server.js";
import { ACTIVE_TASK_STATUSES } from "../../shared/memory-server.js";
import type { ProjectReposMap } from "../../shared/repos.js";
import { upstreamRepo } from "../../shared/repos.js";
import type { PreflightRunContext, PreflightRunState } from "../../shared/run-context.js";

/**
 * `fabric-pr-label` — the port of the Fabric Access pr-label workflow's
 * preflight (`agent/workflows/pr-label/labeled_prs.py` in the instance
 * repo): find open GitHub PRs carrying the bot's label and emit the
 * candidate list the workflow claims one at a time.
 *
 * Behavior parity with the Python script, with the agreed adaptations:
 *
 * - The `BOT_PR_LABEL` (default `dev-bot`) and `GH_USER_NAME` environment
 *   variables become the `pr_label` and `gh_user_name` input parameters
 *   with the same defaults. The other-bot author set, the foreign branch
 *   prefixes (`bot/`, `chore/consolidate-`), the `pr-label:` task key
 *   prefix, and the bracketed Jira-key title pattern stay constants, like
 *   the source.
 * - The `gh pr list --label` subprocesses become the package's GitHub
 *   client on the auth-proxy route, under the shared failure policy: the
 *   Python `gh_pr_list` swallowed every failure and returned `[]` (a
 *   broken credential or route was indistinguishable from "no labeled
 *   PRs"); the port instead skips the repo with recorded evidence when the
 *   listing fails in isolation and escalates to an `error` naming the
 *   required route when every attempted listing failed — the same reading
 *   the hcc/obsint ports gave this swallow pattern. Memory-server fetches
 *   fail closed through the shared client (auth rejections raise).
 * - The Python printed per-PR foreign skips to stderr only; the port
 *   appends them to the result content so the cycle report shows why a PR
 *   was not a candidate, and adds the `task_add` claim instruction (the
 *   workflow's own convention) after the JSON payload.
 */

/** Task key prefix — this workflow's tasks, never the Jira/Konflux ones. */
const TASK_KEY_PREFIX = "pr-label:";

/**
 * Head-branch prefixes owned by the other Fabric Access workflows: `bot/`
 * is the Jira bot's branch convention, `chore/consolidate-` the Konflux
 * squash consolidation branches.
 */
const FOREIGN_BRANCH_PREFIXES: readonly string[] = ["bot/", "chore/consolidate-"];

/** Bot authors whose PRs belong to the Jira or Konflux workflows. */
const FOREIGN_AUTHORS: ReadonlySet<string> = new Set([
  "platex-rehor-bot",
  "red-hat-konflux[bot]",
  "red-hat-konflux",
]);

/** The bracketed Jira key the PR-title policy requires, e.g. `[RHCLOUD-12345]`. */
const JIRA_TITLE_RE = /\[([A-Z][A-Z0-9]+-\d+)\]/;

export const FABRIC_PR_LABEL_INPUT = z.strictObject({
  /**
   * GitHub PR label selecting this workflow's PRs (the Python
   * `BOT_PR_LABEL` env). Independent of the Jira `BOT_LABEL`.
   */
  pr_label: z.string().default("dev-bot"),
  /**
   * GitHub login of this fleet's Jira-bot user (the Python `GH_USER_NAME`
   * env): PRs authored by it belong to the Jira workflow and are foreign.
   */
  gh_user_name: z.string().default(""),
});

export type FabricPrLabelParams = z.infer<typeof FABRIC_PR_LABEL_INPUT>;

/**
 * One labeled-PR candidate — the Python `candidates` entry verbatim: the
 * fields the workflow's claim step consumes, including the exact
 * `task_add` external key.
 */
export interface LabeledPrCandidate {
  readonly repo: string;
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly branch: string;
  readonly author: string;
  readonly jira_key: string | null;
  readonly is_fork: boolean;
  readonly can_push: boolean;
  readonly task_key: string;
}

/** Dependencies of the ported `main()` flow, injectable for tests. */
export interface FabricPrLabelDeps {
  readonly memory: MemoryServerClient;
  readonly github: GitHubClient;
  readonly repos: ProjectReposMap;
  readonly state: PreflightRunState;
}

/** The task key of one labeled PR: `pr-label:<owner/repo>#<number>`. */
export function prLabelTaskKey(ownerRepo: string, number: number): string {
  return `${TASK_KEY_PREFIX}${ownerRepo}#${number}`;
}

/** The bracketed Jira key required by the PR-label workflow, or null. */
export function jiraKeyFromTitle(title: string | null | undefined): string | null {
  const match = JIRA_TITLE_RE.exec(title ?? "");
  return match === null ? null : match[1];
}

/**
 * Keep only this workflow's tasks so a shared instance_id cannot mix in
 * Jira/Konflux work — the Python `own_tasks`, key prefix `pr-label:`.
 */
export function ownPrLabelTasks(tasks: readonly MemoryTask[]): MemoryTask[] {
  return tasks.filter(
    (task) =>
      typeof task.external_key === "string" && task.external_key.startsWith(TASK_KEY_PREFIX),
  );
}

/** The PR author's login, `?` when absent (the Python `_author_login`). */
export function authorLogin(pr: GhOpenPr): string {
  return typeof pr.author === "string" && pr.author !== "" ? pr.author : "?";
}

/**
 * True when this PR belongs to the Jira or Konflux squash workflow — the
 * Python `is_foreign_pr`: a foreign branch prefix, the configured bot
 * user, or a known foreign bot author (all comparisons lowercased).
 */
export function isForeignPr(pr: GhOpenPr, ghUserName: string): boolean {
  const branch = (pr.headRefName ?? "").toLowerCase();
  if (FOREIGN_BRANCH_PREFIXES.some((prefix) => branch.startsWith(prefix))) {
    return true;
  }
  const author = authorLogin(pr).toLowerCase();
  const botUser = (ghUserName ?? "").toLowerCase();
  if (botUser !== "" && author === botUser) {
    return true;
  }
  return FOREIGN_AUTHORS.has(author);
}

/**
 * Whether the workflow can push commits onto the PR's head branch — the
 * Python `can_push`: same-repository branches always, cross-repository
 * (fork) PRs only with maintainer edits allowed.
 */
export function canPush(pr: GhOpenPr): boolean {
  if (pr.isCrossRepository) {
    return pr.maintainerCanModify === true;
  }
  return true;
}

/**
 * The ported `main()` flow: own-task capacity gate, project-repos scan for
 * open labeled PRs, foreign/tracked filtering, then the candidate payload.
 */
export async function runFabricPrLabel(
  deps: FabricPrLabelDeps,
  params: FabricPrLabelParams,
): Promise<PreflightExecutionResult> {
  // Capacity gate: this workflow's own active tasks versus the shared max.
  // The Python counted `pr-label:*` tasks only (own_tasks) but read the max
  // from get_capacity, so a full instance queue from another workflow does
  // not idle this one while its own count is below the max.
  const ownTasks = ownPrLabelTasks(await deps.memory.getTasks());
  const activeOwn = ownTasks.filter((task) =>
    ACTIVE_TASK_STATUSES.includes(task?.status ?? ""),
  ).length;
  const capacity = await deps.memory.getCapacity();
  if (activeOwn >= capacity.max) {
    return { status: "skip", content: `At capacity (${activeOwn}/${capacity.max})` };
  }

  const repoNames = Object.keys(deps.repos);
  if (repoNames.length === 0) {
    return { status: "skip", content: "No repos found in project-repos.json" };
  }

  const ghRepos: string[] = [];
  for (const repoName of repoNames) {
    const { upstreamPath, host } = upstreamRepo(repoName, deps.repos);
    if (upstreamPath !== "" && host === "github") {
      ghRepos.push(upstreamPath);
    }
  }
  if (ghRepos.length === 0) {
    return { status: "skip", content: "No GitHub repos in project-repos.json" };
  }

  const tracker = new FetchTracker();
  const candidates: LabeledPrCandidate[] = [];
  const skipReasons: string[] = [];
  let tracked = 0;
  let foreign = 0;

  for (const upstreamPath of ghRepos) {
    let prs: readonly GhOpenPr[];
    try {
      prs = await deps.github.listOpenPrs(upstreamPath, { label: params.pr_label });
    } catch (error) {
      // Isolated listing failure: skip this repo, keep scanning (see the
      // module doc for the deviation from the Python's silent []).
      tracker.recordFailure(upstreamPath, error);
      continue;
    }
    tracker.recordSuccess();

    for (const pr of prs) {
      if (!pr.number) {
        continue;
      }
      if (isForeignPr(pr, params.gh_user_name)) {
        foreign += 1;
        skipReasons.push(
          `  ${upstreamPath}#${pr.number}: owned by Jira/Konflux bot ` +
            `(branch=${pr.headRefName ?? ""}, author=${authorLogin(pr)})`,
        );
        continue;
      }
      const key = prLabelTaskKey(upstreamPath, pr.number);
      if (ownTasks.some((task) => task.external_key === key)) {
        tracked += 1;
        continue;
      }
      candidates.push({
        repo: upstreamPath,
        number: pr.number,
        title: pr.title ?? "",
        url: pr.url ?? "",
        branch: pr.headRefName ?? "",
        author: authorLogin(pr),
        jira_key: jiraKeyFromTitle(pr.title),
        is_fork: pr.isCrossRepository === true,
        can_push: canPush(pr),
        task_key: key,
      });
    }
  }

  // The failure policy: a total inability to list the attempted repos is
  // an execution error naming the required route, never a silent "no
  // labeled PRs" skip. Isolated failures are tolerated with evidence.
  const outage = totalFetchFailureError(tracker, {
    system: "GitHub",
    noun: "open-PR list",
    route: deps.github.route,
  });
  if (outage !== null) {
    throw outage;
  }
  const evidence: readonly (readonly [FetchTracker, string])[] = [[tracker, "repo"]];

  if (candidates.length === 0) {
    const bits: string[] = [];
    if (tracked > 0) {
      bits.push(`${tracked} already tracked`);
    }
    if (foreign > 0) {
      bits.push(`${foreign} owned by other-bot workflows`);
    }
    const extra = bits.length > 0 ? ` (${bits.join(", ")})` : "";
    let content = `No open PRs with label '${params.pr_label}'${extra}`;
    if (skipReasons.length > 0) {
      content += `\n${skipReasons.join("\n")}`;
    }
    return { status: "skip", content: appendFetchEvidence(content, evidence) };
  }

  deps.state.set("labeled_prs", candidates.length);
  // The payload is the Python's json.dumps(..., indent=2) shape: {label,
  // prs[]} with every candidate field. Skip reasons and the claim
  // instruction follow the JSON so the payload stays extractable.
  let content = JSON.stringify({ label: params.pr_label, prs: candidates }, null, 2);
  if (skipReasons.length > 0) {
    content += `\n\nSkipped PRs:\n${skipReasons.join("\n")}`;
  }
  content +=
    "\n\nClaim one candidate per cycle with task_add: external_key = its task_key, " +
    'source_type "github", instance_id from BOT_INSTANCE_ID, repo, branch, title, ' +
    'status "pr_open", and metadata { jira_key, prs: [{ repo, number, url, host: "github" }] }.';
  return { status: "start", content: appendFetchEvidence(content, evidence) };
}

/**
 * The registered preflight. Wires the run context into the flow: the GitHub
 * client is built from the run's auth-proxy route, the repo map and state
 * come from the instance config, and any failure — including an unwired
 * proxy route — surfaces as an `error` result, never a silent skip.
 */
export const fabricPrLabel = definePreflight({
  id: "fabric-pr-label",
  input: FABRIC_PR_LABEL_INPUT,
  run: async (
    ctx: PreflightRunContext,
    params: FabricPrLabelParams,
  ): Promise<PreflightExecutionResult> => {
    if (ctx.proxy === undefined) {
      return {
        status: "error",
        content:
          "fabric-pr-label: auth proxy route is not wired for this run (missing proxy base URL)",
      };
    }
    try {
      return await runFabricPrLabel(
        {
          memory: ctx.memory,
          state: ctx.state,
          github: createGitHubClient(
            typeof ctx.proxy === "string" ? { baseUrl: ctx.proxy } : ctx.proxy,
          ),
          repos: ctx.repos ?? {},
        },
        params,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { status: "error", content: `fabric-pr-label: ${message}` };
    }
  },
});
