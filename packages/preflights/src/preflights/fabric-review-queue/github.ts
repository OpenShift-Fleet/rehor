import { GITHUB_PATH_PREFIX, GITHUB_TIMEOUT_MS } from "../../shared/github.js";
import { composeRoute } from "../../shared/http.js";
import type { ProxyRouteConfig } from "../../shared/run-context.js";

export type RecordData = Record<string, unknown>;
export const object = (value: unknown): value is RecordData =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export const id = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
export const login = (value: unknown): value is string =>
  typeof value === "string" && /^[a-z\d](?:[a-z\d-]*[a-z\d])?(?:\[bot\])?$/i.test(value);
export const sha = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f\d]{40}$/.test(value);
export const timestamp = (value: unknown): number =>
  typeof value === "string" && /T.*(?:Z|[+-]\d\d:\d\d)$/.test(value)
    ? Date.parse(value)
    : Number.NaN;

export interface Pull {
  number: number;
  head: string;
  base: string;
  updated: string;
  draft: boolean;
  author: string;
  state: "open" | "closed";
  merged: string | null;
  labels: readonly string[];
}

const WAITING_LABEL = "dev-bot-review-waiting-for-approval";

/** Queue-specific GitHub REST calls. Pagination reuses the original validated
 * endpoint; upstream Link URLs never become transport destinations. */
export function reviewGitHub(proxy: ProxyRouteConfig) {
  const route = new URL(composeRoute(proxy.baseUrl, GITHUB_PATH_PREFIX));
  if (route.username || route.password || route.hash || route.search) {
    throw new Error("Invalid GitHub proxy route");
  }
  const fetcher = proxy.fetch ?? fetch;
  async function send(path: string, method = "GET", body?: object): Promise<Response> {
    const url = new URL(`${route.href}${path}`);
    if (url.origin !== route.origin || !url.pathname.startsWith(`${route.pathname}/`)) {
      throw new Error("Invalid GitHub queue endpoint");
    }
    return fetcher(url.href, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
      headers: {
        Accept: "application/vnd.github+json",
        ...(body && { "Content-Type": "application/json" }),
      },
      ...(body && { body: JSON.stringify(body) }),
    });
  }
  function requireOk(response: Response): void {
    if (!response.ok) throw new Error(`GitHub queue request failed (HTTP ${response.status})`);
  }
  async function read(path: string): Promise<RecordData> {
    const response = await send(path);
    requireOk(response);
    const value: unknown = await response.json();
    if (!object(value)) throw new Error("Invalid GitHub queue response");
    return value;
  }
  async function list(path: string, query: Record<string, string> = {}): Promise<RecordData[]> {
    const result: RecordData[] = [];
    const params = new URLSearchParams({ ...query, per_page: "100" });
    for (let page = 1; page <= 100; page += 1) {
      params.set("page", String(page));
      const response = await send(`${path}?${params}`);
      requireOk(response);
      const value: unknown = await response.json();
      if (!Array.isArray(value) || !value.every(object))
        throw new Error("Invalid GitHub queue page");
      result.push(...value);
      if (!/;\s*rel\s*=\s*"?next\b/i.test(response.headers.get("link") ?? "")) return result;
    }
    throw new Error("GitHub queue pagination limit reached");
  }
  const repoPath = (repo: string) => `/repos/${repo}`;
  const issue = (repo: string, number: number) => `${repoPath(repo)}/issues/${number}`;
  const pull = (repo: string, number: number) => `${repoPath(repo)}/pulls/${number}`;

  return {
    async whoami(): Promise<string> {
      const value = await read("/user");
      if (!login(value.login)) throw new Error("Cannot identify GitHub queue bot account");
      return value.login.toLowerCase();
    },
    async labeled(repo: string, label: string): Promise<number[]> {
      const rows = await list(`${repoPath(repo)}/issues`, { state: "open", labels: label });
      return [
        ...new Set(
          rows.flatMap((row) => {
            if (!object(row.pull_request)) return [];
            if (!id(row.number)) throw new Error("Invalid GitHub queue PR number");
            return [row.number];
          }),
        ),
      ];
    },
    async pr(repo: string, number: number): Promise<Pull> {
      const row = await read(pull(repo, number));
      if (
        row.number !== number ||
        (row.state !== "open" && row.state !== "closed") ||
        !object(row.head) ||
        !sha(row.head.sha) ||
        !object(row.base) ||
        !sha(row.base.sha) ||
        !object(row.user) ||
        !login(row.user.login) ||
        typeof row.draft !== "boolean" ||
        typeof row.updated_at !== "string" ||
        !Number.isFinite(timestamp(row.updated_at)) ||
        (row.merged_at !== null &&
          (typeof row.merged_at !== "string" || !Number.isFinite(timestamp(row.merged_at)))) ||
        !Array.isArray(row.labels) ||
        !row.labels.every((label) => object(label) && typeof label.name === "string")
      ) {
        throw new Error("Invalid GitHub pull request response");
      }
      return {
        number,
        head: row.head.sha,
        base: row.base.sha,
        updated: row.updated_at,
        draft: row.draft,
        author: row.user.login.toLowerCase(),
        state: row.state,
        merged: row.merged_at,
        labels: row.labels.map((label) => label.name.toLowerCase()),
      };
    },
    events: (repo: string, number: number) => list(`${issue(repo, number)}/events`),
    issueComments: (repo: string, number: number) => list(`${issue(repo, number)}/comments`),
    inlineComments: (repo: string, number: number) => list(`${pull(repo, number)}/comments`),
    reviews: (repo: string, number: number) => list(`${pull(repo, number)}/reviews`),
    review: (repo: string, number: number, reviewId: number) =>
      read(`${pull(repo, number)}/reviews/${reviewId}`),
    draftComments: (repo: string, number: number, reviewId: number) =>
      list(`${pull(repo, number)}/reviews/${reviewId}/comments`),
    async member(org: string, user: string): Promise<boolean> {
      const response = await send(`/orgs/${org}/members/${encodeURIComponent(user)}`);
      if (response.status === 204) return true;
      if (response.status === 404) return false;
      throw new Error(`GitHub could not verify organization membership (HTTP ${response.status})`);
    },
    async postRequest(repo: string, number: number, body: string): Promise<void> {
      requireOk(await send(`${issue(repo, number)}/comments`, "POST", { body }));
    },
    async updateRequest(repo: string, commentId: number, body: string): Promise<void> {
      requireOk(await send(`${repoPath(repo)}/issues/comments/${commentId}`, "PATCH", { body }));
    },
    async waitingLabel(repo: string, number: number, present: boolean): Promise<void> {
      const path = `${issue(repo, number)}/labels`;
      if (present) {
        const labelPath = `${repoPath(repo)}/labels/${WAITING_LABEL}`;
        const lookup = await send(labelPath);
        if (lookup.status === 404) {
          const created = await send(`${repoPath(repo)}/labels`, "POST", {
            name: WAITING_LABEL,
            color: "ededed",
            description: "Review is waiting for organization-member approval.",
          });
          if (!created.ok) requireOk(await send(labelPath)); // concurrent creation
        } else requireOk(lookup);
        requireOk(await send(path, "POST", { labels: [WAITING_LABEL] }));
      } else {
        const response = await send(`${path}/${WAITING_LABEL}`, "DELETE");
        if (response.status !== 404) requireOk(response);
      }
    },
  };
}

export type ReviewGitHub = ReturnType<typeof reviewGitHub>;
