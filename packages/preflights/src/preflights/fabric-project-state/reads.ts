import { createHttpClient, isPreflightHttpError } from "../../shared/http.js";
import type { ProjectReposMap } from "../../shared/repos.js";
import type { ProxyWiring } from "../../shared/run-context.js";
import {
  keyOf,
  labels,
  parsePythonCompatibleJson,
  type RecordData,
  record,
  sorted,
  text,
} from "./snapshot.js";

const ISSUE_KEY = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;
const API = "/rest/api/2";
const PAGE_SIZE = 50;
const MAX_JIRA_PAGES = 100;

function requireRecord(value: unknown, message: string): RecordData {
  const obj = record(value);
  if (!obj || obj.errorMessages || obj.isError || obj.success === false) throw new Error(message);
  return obj;
}

export function issueKey(value: unknown): string {
  const key = keyOf(value);
  if (!ISSUE_KEY.test(key)) throw new Error("Missing or invalid Jira issue key");
  return key;
}

// The generic Jira client normalizes search ADF and admits missing/truncated
// arrays as empty. This workflow needs raw fields and complete pages to hash.
export function createProjectReads(proxy: ProxyWiring) {
  const config = typeof proxy === "string" ? { baseUrl: proxy } : proxy;
  const jira = createHttpClient({
    ...config,
    parseJson: parsePythonCompatibleJson,
    pathPrefix: "/jira",
    timeoutMs: 30_000,
  });
  const github = createHttpClient({ ...config, pathPrefix: "/github", timeoutMs: 20_000 });

  async function search(jql: string, fields: readonly string[]) {
    const issues: RecordData[] = [];
    const keys = new Set<string>();
    const tokens = new Set<string>();
    let nextPageToken: string | undefined;
    for (let page = 0; page < MAX_JIRA_PAGES; page++) {
      const result = requireRecord(
        await jira.postJson(`${API}/search/jql`, {
          jql,
          fields,
          maxResults: PAGE_SIZE,
          nextPageToken,
        }),
        "Invalid Jira search response",
      );
      if (!Array.isArray(result.issues)) throw new Error("Jira search returned no issue list");
      for (const item of result.issues) {
        const issue = requireRecord(item, "Invalid Jira search issue");
        const key = issueKey(issue);
        if (keys.has(key)) throw new Error(`Jira search repeated issue ${key}`);
        keys.add(key);
        issues.push(issue);
      }
      nextPageToken = text(result.nextPageToken) || undefined;
      if (result.isLast === true && !nextPageToken) return issues;
      if (result.isLast === true || !nextPageToken || tokens.has(nextPageToken)) {
        throw new Error("Invalid Jira search pagination");
      }
      tokens.add(nextPageToken);
    }
    throw new Error("Jira search exceeded page limit");
  }

  async function issue(key: string, fields: readonly string[]) {
    const result = requireRecord(
      await jira.getJson(`${API}/issue/${encodeURIComponent(key)}`, {
        query: { fields: fields.join(",") },
      }),
      `Invalid Jira issue response for ${key}`,
    );
    if (issueKey(result) !== key || !record(result.fields))
      throw new Error(`Invalid Jira issue response for ${key}`);
    return result;
  }

  async function comments(key: string) {
    const items: RecordData[] = [];
    const ids = new Set<string>();
    for (let page = 0; page < MAX_JIRA_PAGES; page++) {
      const result = requireRecord(
        await jira.getJson(`${API}/issue/${encodeURIComponent(key)}/comment`, {
          query: { startAt: items.length, maxResults: PAGE_SIZE, orderBy: "created" },
        }),
        `Invalid Jira comment response for ${key}`,
      );
      if (
        !Array.isArray(result.comments) ||
        typeof result.total !== "number" ||
        !Number.isSafeInteger(result.total) ||
        result.total < items.length + result.comments.length ||
        (result.startAt !== undefined && result.startAt !== items.length)
      ) {
        throw new Error(`Invalid Jira comment pagination for ${key}`);
      }
      for (const item of result.comments) {
        const comment = requireRecord(item, `Invalid Jira comment on ${key}`);
        const id = typeof comment.id === "number" ? String(comment.id) : text(comment.id);
        if (!id || ids.has(id) || !Object.hasOwn(comment, "body"))
          throw new Error(`Invalid Jira comment on ${key}`);
        ids.add(id);
        items.push(comment);
      }
      if (items.length === result.total) return items;
      if (result.comments.length === 0) throw new Error(`Jira comments truncated for ${key}`);
    }
    throw new Error(`Jira comments exceeded page limit for ${key}`);
  }

  type PullRequest = { repo: string; number: number; title: string; url: string; labels: string[] };
  async function openPulls(repo: string): Promise<PullRequest[]> {
    const prs: PullRequest[] = [];
    const numbers = new Set<number>();
    // Probe for overflow after 1000 PRs, the legacy scan bound.
    for (let page = 1; page <= 11; page++) {
      const result = await github.getJson<unknown>(`/repos/${repo}/pulls`, {
        query: { state: "open", sort: "created", direction: "desc", per_page: 100, page },
      });
      if (!Array.isArray(result)) throw new Error(`Invalid GitHub PR list for ${repo}`);
      if (prs.length + result.length > 1000)
        throw new Error(`GitHub PR list exceeded scan limit for ${repo}`);
      for (const item of result) {
        const pr = record(item);
        if (
          !pr ||
          typeof pr.number !== "number" ||
          !Number.isSafeInteger(pr.number) ||
          pr.number <= 0 ||
          numbers.has(pr.number) ||
          typeof pr.title !== "string" ||
          !Array.isArray(pr.labels)
        ) {
          throw new Error(`Invalid GitHub PR for ${repo}`);
        }
        const names = pr.labels.map((label) => text(record(label)?.name));
        if (names.some((name) => !name)) throw new Error(`Invalid GitHub PR labels for ${repo}`);
        numbers.add(pr.number);
        prs.push({
          repo,
          number: pr.number,
          title: pr.title,
          labels: sorted(names),
          url: text(pr.html_url) || `https://github.com/${repo}/pull/${pr.number}`,
        });
      }
      if (result.length < 100) return prs;
    }
    throw new Error(`GitHub PR list exceeded scan limit for ${repo}`);
  }

  const prCache = new Map<string, PullRequest[]>();
  async function prSnapshot(
    children: readonly RecordData[],
    implementationLabel: string,
    repos: ProjectReposMap,
  ) {
    const byRepo = new Map<string, Set<string>>();
    for (const child of children) {
      const childLabels = labels(child);
      if (!childLabels.includes(implementationLabel)) continue;
      for (const label of childLabels.filter((value) => value.startsWith("repo:"))) {
        const name = label.slice(5);
        const assigned = byRepo.get(name) ?? new Set();
        assigned.add(issueKey(child));
        byRepo.set(name, assigned);
      }
    }
    const tickets: Record<string, PullRequest[]> = {};
    for (const name of sorted(byRepo.keys())) {
      const keys = byRepo.get(name) ?? new Set<string>();
      for (const key of keys) tickets[key] ??= [];
      const entry = Object.hasOwn(repos, name) ? repos[name] : undefined;
      const upstream = text(entry?.upstream) || text(entry?.url);
      const match = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(
        upstream,
      );
      if (!match) {
        if (/^https:\/\/(gitlab\.com|gitlab\.cee\.redhat\.com)\//.test(upstream)) continue;
        throw new Error(
          `Missing or unsupported upstream for handed-off repo ${name || "(empty label)"}`,
        );
      }
      if (match.slice(1).some((part) => part === "." || part === ".."))
        throw new Error("Invalid GitHub upstream path");
      const repo = `${match[1]}/${match[2]}`;
      let prs = prCache.get(repo);
      if (!prs) {
        prs = await openPulls(repo);
        prCache.set(repo, prs);
      }
      for (const key of keys) {
        const marker = new RegExp(`(?<![A-Za-z0-9])\\[${key}\\](?![A-Za-z0-9])`, "i");
        tickets[key].push(...prs.filter((pr) => marker.test(pr.title)));
      }
    }
    for (const prs of Object.values(tickets)) {
      prs.sort((a, b) => (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : a.number - b.number));
    }
    return tickets;
  }

  return { search, issue, comments, prSnapshot };
}

export function readError(error: unknown): string {
  if (isPreflightHttpError(error)) {
    // Upstream error bodies and request URLs may contain sensitive data.
    return error.status === null ? "upstream request failed" : `upstream HTTP ${error.status}`;
  }
  return error instanceof Error ? error.message : "read failed";
}
