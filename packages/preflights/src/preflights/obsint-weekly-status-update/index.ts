import { z } from "zod";
import { definePreflight } from "../../core/registry.js";
import type { PreflightExecutionResult } from "../../core/results.js";
import type { GitHubClient } from "../../shared/github.js";
import { createGitHubClient } from "../../shared/github.js";
import type { PreflightRunContext } from "../../shared/run-context.js";
import type { SlackClient } from "../../shared/slack.js";
import type { PersistentStateStore } from "../../shared/state.js";
import { isoDateUtc } from "../../shared/time.js";
import { executionErrorResult } from "../jira-common/errors.js";
import { isoWeekKeyUtc } from "../obsint-common/time.js";

/**
 * `obsint-weekly-status-update` — the port of the watchduty preflight
 * `03-weekly-status-update.py` (Advisor and MPEX weekly status watcher).
 *
 * The HP weekly status repo uses Friday-dated report folders, e.g.:
 *   reports/2026/2026-10-30/mpex/lightspeed-advisor.md
 *   reports/2026/2026-10-30/mpex.md
 *
 * This preflight polls exact expected paths during Friday working hours. It
 * sends one combined Slack message only after all expected reports are
 * present. On Monday it performs one AI-assisted fallback check for any
 * still-missing report, then marks that weekly watcher closed so the bot
 * does not keep searching every hour.
 *
 * Exit conditions:
 * - outside the Friday/Monday watch windows -> skip
 * - all expected reports present and the combined message not yet posted ->
 *   send one Slack message, persist the marker, skip
 * - combined message already posted (or check already closed) -> skip
 * - some expected reports missing on Friday -> skip and keep polling hourly
 * - some expected reports still missing during the Monday fallback -> start
 *   one AI session to search for moved/renamed/misfiled reports, mark the
 *   weekly check closed, and skip the rest of the week. Missing reports are
 *   OK; silent format drift is what we want to catch.
 *
 * Behavior parity with the Python script, with the deliberate adaptations
 * the engine requires:
 *
 * - The Python env constants (timezone, weekday/hour windows, repo, ref,
 *   report list) become input parameters with the same defaults.
 * - Report presence is probed with the GitHub client's raw contents fetch
 *   (`getFileContents`, 404 -> missing) instead of a `gh api` metadata call:
 *   the `sha` of a found report is recorded as an empty string and the URL
 *   is constructed like the Python's `html_url` fallback
 *   (`https://github.com/<repo>/blob/<ref>/<path>`). A non-404 fetch
 *   failure throws and errors the run — the Python treated any `gh`
 *   failure as "not available yet", but the engine route treats real
 *   outages as errors, never silent misses.
 * - The `{stateKey: {...}}` state dict lives in the run context's
 *   persistent state store under `obsint-weekly-status-update:state`
 *   instead of the `BOT_DATA_DIR` state file; the Monday prompt's "Dedup
 *   state file" line is dropped (there is no file) while the state key
 *   line stays.
 * - Timestamps (`posted_at`, `path_check_requested_at`, the prompt's
 *   current time) are UTC ISO-8601 instants; the Python printed local
 *   offsets from `ZoneInfo`.
 * - The combined message goes through `slack.sendTo("weeklyStatus", ...)`,
 *   which falls back to the default webhook — the Python's
 *   `WEEKLY_STATUS_SLACK_WEBHOOK_URL or SLACK_WEBHOOK_URL`. An unwired
 *   client or a failed send degrades to the Python's "Slack announcement
 *   failed" skip, never an error, and leaves the week unmarked so the next
 *   cycle retries.
 */

/** One expected report definition (the Python `DEFAULT_REPORTS` entries). */
export interface WeeklyStatusReportDef {
  readonly id: string;
  readonly title: string;
  readonly path_template: string;
  readonly search_hint: string;
}

export const OBSINT_WEEKLY_STATUS_INPUT = z.strictObject({
  /** IANA time zone the publication windows are read in. */
  timezone: z.string().default("Europe/Prague"),
  /** Friday exact-path polling window (Monday=0 … Friday=4). */
  poll_weekday: z.number().int().min(0).max(6).default(4),
  poll_start_hour: z.number().int().min(0).max(23).default(8),
  poll_end_hour: z.number().int().min(0).max(23).default(16),
  /** Monday one-shot AI fallback window. */
  ai_check_weekday: z.number().int().min(0).max(6).default(0),
  ai_check_start_hour: z.number().int().min(0).max(23).default(8),
  ai_check_end_hour: z.number().int().min(0).max(23).default(12),
  /** Repository of the weekly status reports, `owner/repo`. */
  repo: z
    .string()
    .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "repo must look like owner/repo")
    .default("openshift-eng/hp-weekly-status"),
  /** Ref (branch) the reports are read from. */
  ref: z.string().default("main"),
  /** Expected reports (id, title, path template, search hint). */
  reports: z
    .array(
      z.strictObject({
        id: z.string(),
        title: z.string(),
        path_template: z.string(),
        search_hint: z.string(),
      }),
    )
    .default([
      {
        id: "advisor",
        title: "Advisor / Lightspeed Advisor",
        path_template: "reports/{year}/{date}/mpex/lightspeed-advisor.md",
        search_hint: "advisor|lightspeed|mpex",
      },
      {
        id: "mpex",
        title: "MPEX rollup",
        path_template: "reports/{year}/{date}/mpex.md",
        search_hint: "mpex",
      },
    ]),
});

export type ObsintWeeklyStatusParams = z.infer<typeof OBSINT_WEEKLY_STATUS_INPUT>;

/** Persistent-state key holding the whole `{stateKey: {...}}` state dict. */
export const WEEKLY_STATUS_STATE_KEY = "obsint-weekly-status-update:state";

/** The Slack channel name of the weekly-status webhook override. */
export const WEEKLY_STATUS_SLACK_CHANNEL = "weeklyStatus";

/** A found report, with the data the state entries and messages carry. */
interface PresentReport {
  readonly report: WeeklyStatusReportDef;
  readonly path: string;
  readonly sha: string;
  readonly url: string;
  readonly content: string;
}

/** A missing report — the Python `missing` items. */
interface MissingReport {
  readonly report: WeeklyStatusReportDef;
  readonly path: string;
}

/** One persisted watcher state entry (either the posted or the closed shape). */
interface WeeklyStatusStateEntry {
  readonly posted: boolean;
  readonly closed: boolean;
  readonly posted_at?: string;
  readonly path_check_requested?: boolean;
  readonly path_check_requested_at?: string;
  readonly repo?: string;
  readonly ref?: string;
  readonly report_ids?: readonly string[];
  readonly present?: readonly { id: string; path: string; sha: string; url: string }[];
  readonly missing?: readonly { id: string; path: string }[];
  readonly reports?: readonly { id: string; path: string; sha: string; url: string }[];
  readonly target_date?: string;
  readonly reason?: string;
}

type WeeklyStatusState = Record<string, WeeklyStatusStateEntry>;

/** Dependencies of the ported `main()` flow, injectable for tests. */
export interface ObsintWeeklyStatusDeps {
  readonly github: GitHubClient;
  readonly persistentState: PersistentStateStore;
  readonly slack?: SlackClient;
  /** Injectable clock so tests can fix the weekday and the hour. */
  readonly now?: () => Date;
}

/** The local calendar date of `now` in `timeZone`, as a UTC-midnight Date. */
function localTime(now: Date, timeZone: string): { today: Date; hour: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const record: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== "literal") record[part.type] = Number(part.value);
  }
  return {
    today: new Date(Date.UTC(record.year, record.month - 1, record.day)),
    hour: record.hour,
  };
}

/** Python `weekday()` on a UTC-midnight date: Monday=0 … Sunday=6. */
function weekdayOf(date: Date): number {
  return (date.getUTCDay() + 6) % 7;
}

function shiftDays(date: Date, days: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + days));
}

/**
 * The Python `_target_friday`: the Friday report date of the current
 * Friday/Monday cycle — the poll weekday itself, or (from the earlier AI
 * fallback weekday) the previous Friday.
 */
function targetFriday(today: Date, pollWeekday: number, aiCheckWeekday: number): Date {
  const weekday = weekdayOf(today);
  if (weekday === aiCheckWeekday && aiCheckWeekday < pollWeekday) {
    return shiftDays(today, -(7 - pollWeekday + aiCheckWeekday));
  }
  if (weekday <= pollWeekday) {
    return shiftDays(today, pollWeekday - weekday);
  }
  return shiftDays(today, -(weekday - pollWeekday));
}

/** The Python `_report_path`: template substitution of year and date. */
function reportPath(report: WeeklyStatusReportDef, target: Date): string {
  return report.path_template
    .replaceAll("{year}", String(target.getUTCFullYear()))
    .replaceAll("{date}", isoDateUtc(target));
}

/** A plain-object check for the persisted state dict (tolerant read). */
function isStateRecord(value: unknown): value is WeeklyStatusState {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The Python `_slack_safe_excerpt`: keep each report excerpt compact while
 * preserving manager-authored text — headings read as bold in mrkdwn, and
 * over-long text is clipped with an ellipsis.
 */
function slackSafeExcerpt(content: string, limit = 1200): string {
  if (content === "") return "";
  const lines: string[] = [];
  for (const line of content.split("\n")) {
    if (line.startsWith("# ")) {
      lines.push(`*${line.slice(2).trim()}*`);
    } else if (line.startsWith("## ")) {
      lines.push(`*${line.slice(3).trim()}*`);
    } else {
      lines.push(line);
    }
  }
  const text = lines.join("\n").trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit).trimEnd()}\n…`;
}

export async function runObsintWeeklyStatusUpdate(
  deps: ObsintWeeklyStatusDeps,
  params: ObsintWeeklyStatusParams,
): Promise<PreflightExecutionResult> {
  const now = deps.now?.() ?? new Date();

  const { today, hour } = localTime(now, params.timezone);
  const weekday = weekdayOf(today);
  const inPollWindow =
    weekday === params.poll_weekday &&
    hour >= params.poll_start_hour &&
    hour < params.poll_end_hour;
  const aiCheckDue =
    weekday === params.ai_check_weekday &&
    hour >= params.ai_check_start_hour &&
    hour < params.ai_check_end_hour;
  if (!inPollWindow && !aiCheckDue) {
    return {
      status: "skip",
      content: "Weekly status watcher outside Friday/Monday publication windows",
    };
  }

  const target = targetFriday(today, params.poll_weekday, params.ai_check_weekday);
  const targetDate = isoDateUtc(target);
  const stateKey = `${isoWeekKeyUtc(target)}:combined:${params.reports.map((report) => report.id).join("+")}`;

  const rawState = await deps.persistentState.get<unknown>(WEEKLY_STATUS_STATE_KEY);
  const state: WeeklyStatusState = isStateRecord(rawState) ? rawState : {};
  const already = state[stateKey];
  if (already !== undefined && already.closed) {
    if (already.posted) {
      return {
        status: "skip",
        content: `Combined weekly status already announced for ${targetDate}`,
      };
    }
    return {
      status: "skip",
      content: `Combined weekly status check already closed for ${targetDate}`,
    };
  }

  const present: PresentReport[] = [];
  const missing: MissingReport[] = [];
  for (const report of params.reports) {
    const path = reportPath(report, target);
    const content = await deps.github.getFileContents(params.repo, path, params.ref);
    if (content === null) {
      missing.push({ report, path });
      continue;
    }
    present.push({
      report,
      path,
      sha: "",
      url: `https://github.com/${params.repo}/blob/${params.ref}/${path}`,
      content: content.trim(),
    });
  }

  if (missing.length > 0) {
    if (aiCheckDue) {
      // Mark the watcher closed BEFORE starting the session, so an
      // unfound report does not restart the search every hour.
      const entry: WeeklyStatusStateEntry = {
        posted: false,
        closed: true,
        path_check_requested: true,
        path_check_requested_at: now.toISOString(),
        repo: params.repo,
        ref: params.ref,
        report_ids: params.reports.map((report) => report.id),
        present: present.map((item) => ({
          id: item.report.id,
          path: item.path,
          sha: item.sha,
          url: item.url,
        })),
        missing: missing.map((item) => ({ id: item.report.id, path: item.path })),
        target_date: targetDate,
        reason: "one or more expected reports missing at Monday AI fallback window",
      };
      await deps.persistentState.set(WEEKLY_STATUS_STATE_KEY, { ...state, [stateKey]: entry });
      return {
        status: "start",
        content: missingReportPrompt(now, targetDate, stateKey, params, present, missing),
      };
    }
    return {
      status: "skip",
      content: `Waiting for all weekly status reports for ${targetDate}: ${missing
        .map((item) => item.path)
        .join(", ")}`,
    };
  }

  const sent =
    deps.slack !== undefined
      ? await deps.slack.sendTo(
          WEEKLY_STATUS_SLACK_CHANNEL,
          combinedSlackMessage(targetDate, present),
        )
      : false;
  if (!sent) {
    return {
      status: "skip",
      content: `All weekly status reports found for ${targetDate}, but Slack announcement failed`,
    };
  }

  const entry: WeeklyStatusStateEntry = {
    posted: true,
    closed: true,
    posted_at: now.toISOString(),
    repo: params.repo,
    ref: params.ref,
    report_ids: params.reports.map((report) => report.id),
    reports: present.map((item) => ({
      id: item.report.id,
      path: item.path,
      sha: item.sha,
      url: item.url,
    })),
    target_date: targetDate,
  };
  await deps.persistentState.set(WEEKLY_STATUS_STATE_KEY, { ...state, [stateKey]: entry });
  return { status: "skip", content: `Announced combined weekly status for ${targetDate}` };
}

/** The Python `_send_combined_slack` message (delivery is the caller's). */
function combinedSlackMessage(targetDate: string, present: readonly PresentReport[]): string {
  const lines: string[] = [
    `🗓️ *Advisor and MPEX weekly status updates are available* — ${targetDate}`,
    "",
  ];
  for (const item of present) {
    lines.push(`*${item.report.title}*`);
    lines.push(`<${item.url}|${item.path}>`);
    const excerpt = slackSafeExcerpt(item.content);
    if (excerpt !== "") {
      lines.push("");
      lines.push(excerpt);
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}

/**
 * The Python `_missing_report_prompt`: the Monday AI-fallback start prompt.
 * Ported verbatim (message-composer subagent, gh api checks, absence
 * handling) except for the documented adaptations — UTC ISO timestamps and
 * the dropped state-file line.
 */
function missingReportPrompt(
  now: Date,
  targetDate: string,
  stateKey: string,
  params: ObsintWeeklyStatusParams,
  present: readonly PresentReport[],
  missing: readonly MissingReport[],
): string {
  const lines: string[] = [
    "## Weekly status combined-message path check",
    "",
    "One or more expected weekly status files were not found during the Monday fallback window.",
    "The preflight has already marked the combined weekly watcher complete before starting this AI session, so it will not search every hour if no file is found.",
    "",
    `- Current time: ${now.toISOString()}`,
    `- Repo: \`${params.repo}\``,
    `- Ref: \`${params.ref}\``,
    `- Expected Friday folder date: \`${targetDate}\``,
    `- Dedup state key: \`${stateKey}\``,
    "",
  ];

  if (present.length > 0) {
    lines.push("Reports found at the expected paths:");
    for (const item of present) {
      lines.push(`- ${item.report.title}: ${item.url}`);
    }
    lines.push("");
  }

  lines.push("Missing expected reports:");
  const grepTerms = new Set<string>([targetDate]);
  for (const item of missing) {
    const expectedUrl = `https://github.com/${params.repo}/blob/${params.ref}/${item.path}`;
    for (const term of item.report.search_hint.split("|")) {
      grepTerms.add(term);
    }
    lines.push(`- ${item.report.title} (\`${item.report.id}\`)`);
    lines.push(`  - Expected path: \`${item.path}\``);
    lines.push(`  - Expected URL: ${expectedUrl}`);
  }

  const grepExpr = [...grepTerms]
    .filter((term) => term !== "")
    .sort()
    .join("|");
  const year = targetDate.slice(0, 4);
  lines.push(
    "",
    "Please use GitHub CLI/API to check whether the missing reports exist under different paths, date folders, team folders, or filenames. Usual paths are:",
    "",
    "`reports/<year>/<friday-date>/mpex/lightspeed-advisor.md`",
    "`reports/<year>/<friday-date>/mpex.md`",
    "",
    "Useful checks:",
    "",
    "```bash",
    `gh api repos/${params.repo}/contents/reports/${year}/${targetDate}?ref=${params.ref} --jq '.[].path'`,
    `gh api repos/${params.repo}/contents/reports/${year}/${targetDate}/mpex?ref=${params.ref} --jq '.[].path'`,
    `gh api repos/${params.repo}/git/trees/${params.ref}?recursive=1 \\`,
    `  --jq '.tree[].path' | grep -Ei '(${grepExpr})'`,
    "```",
    "",
    "If you find the missing reports in moved/renamed/misdated locations, hand the report links and path changes to the native `message-composer` subagent so it sends ONE combined Slack message for Advisor and MPEX with all available links and a clear note for any expected path that changed. Update the state key with the actual path/url and outcome.",
    "",
    "The message-composer subagent sends to the CVE/status Slack destination and applies the `WEEKLY_STATUS_SLACK_WEBHOOK_URL` override when that env var is set.",
    "",
    "If you do not find any likely missing report, do not send a Slack message just for absence unless a human explicitly asked for absence notifications. It is acceptable for this weekly check to end without success.",
  );
  return lines.join("\n");
}

export const obsintWeeklyStatusUpdate = definePreflight({
  id: "obsint-weekly-status-update",
  input: OBSINT_WEEKLY_STATUS_INPUT,
  run: async (
    ctx: PreflightRunContext,
    params: ObsintWeeklyStatusParams,
  ): Promise<PreflightExecutionResult> => {
    if (ctx.proxy === undefined) {
      return {
        status: "error",
        content:
          "obsint-weekly-status-update: auth proxy route is not wired for this run (missing proxy base URL)",
      };
    }
    if (ctx.persistentState === undefined) {
      return {
        status: "error",
        content:
          "obsint-weekly-status-update requires a wired persistent state store (posted/closed markers would never persist and the watcher would re-announce every cycle)",
      };
    }
    return runObsintWeeklyStatusUpdate(
      {
        github: createGitHubClient(
          typeof ctx.proxy === "string" ? { baseUrl: ctx.proxy } : ctx.proxy,
        ),
        persistentState: ctx.persistentState,
        slack: ctx.slack,
      },
      params,
    ).catch(executionErrorResult);
  },
});
