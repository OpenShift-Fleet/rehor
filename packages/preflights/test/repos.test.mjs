import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildRepoLookup,
  loadProjectRepos,
  matchRepoLabels,
  parseProjectRepos,
  parseRepoPath,
  upstreamRepo,
} from "../dist/shared/repos.js";

// --- upstream_repo (ported from bot/tests/test_preflight_shared.py) ---

test("upstreamRepo passes through qualified github names", () => {
  assert.deepEqual(upstreamRepo("project-kessel/inventory-api", {}), {
    upstreamPath: "project-kessel/inventory-api",
    host: "github",
  });
});

test("upstreamRepo passes through qualified gitlab names", () => {
  assert.deepEqual(upstreamRepo("gitlab.cee.redhat.com/some/repo", {}), {
    upstreamPath: "gitlab.cee.redhat.com/some/repo",
    host: "gitlab",
  });
});

test("upstreamRepo returns empty for an unknown bare repo", () => {
  assert.deepEqual(upstreamRepo("nonexistent", {}), { upstreamPath: "", host: "github" });
});

test("upstreamRepo resolves a bare github repo from its upstream", () => {
  const repos = { "my-repo": { upstream: "https://github.com/org/my-repo.git" } };
  assert.deepEqual(upstreamRepo("my-repo", repos), { upstreamPath: "org/my-repo", host: "github" });
});

test("upstreamRepo resolves a bare gitlab repo from its upstream", () => {
  const repos = { "my-repo": { upstream: "https://gitlab.cee.redhat.com/team/my-repo.git" } };
  assert.deepEqual(upstreamRepo("my-repo", repos), {
    upstreamPath: "team/my-repo",
    host: "gitlab",
  });
});

test("upstreamRepo matches a bare name against the upstream basename", () => {
  const repos = {
    konflux: {
      upstream: "https://gitlab.cee.redhat.com/releng/konflux-release-data.git",
      host: "gitlab",
    },
  };
  assert.deepEqual(upstreamRepo("konflux-release-data", repos), {
    upstreamPath: "releng/konflux-release-data",
    host: "gitlab",
  });
});

test("upstreamRepo matches a bare name against map keys ending with /name", () => {
  const repos = { "team/rbac": { upstream: "https://gitlab.cee.redhat.com/team/rbac.git" } };
  assert.deepEqual(upstreamRepo("rbac", repos), { upstreamPath: "team/rbac", host: "gitlab" });
});

test("upstreamRepo handles scp-like ssh upstreams with non-numeric ports", () => {
  // ssh://git@gitlab.cee.redhat.com:team/repo.git has a non-numeric "port";
  // WHATWG URL rejects it, so the hostname must come from the fallback parse.
  const repos = { "my-repo": { upstream: "git@gitlab.cee.redhat.com:team/my-repo.git" } };
  assert.deepEqual(upstreamRepo("my-repo", repos), {
    upstreamPath: "team/my-repo",
    host: "gitlab",
  });
});

test("upstreamRepo falls back to the entry host for other hostnames", () => {
  const repos = {
    internal: { upstream: "https://git.corp.example/team/internal.git", host: "gitlab" },
    plain: { upstream: "https://git.corp.example/team/plain.git" },
  };
  assert.deepEqual(upstreamRepo("internal", repos), {
    upstreamPath: "team/internal",
    host: "gitlab",
  });
  assert.deepEqual(upstreamRepo("plain", repos), { upstreamPath: "team/plain", host: "github" });
});

// --- parseRepoPath ---

test("parseRepoPath extracts org/repo from https and scp-like git URLs", () => {
  assert.equal(parseRepoPath("https://github.com/org/repo.git"), "org/repo");
  assert.equal(parseRepoPath("https://gitlab.cee.redhat.com/team/repo.git"), "team/repo");
  assert.equal(parseRepoPath("git@github.com:org/repo.git"), "org/repo");
  assert.equal(parseRepoPath("org/repo"), "org/repo");
  assert.equal(parseRepoPath("repo"), "repo");
  // Python parity wart: an ssh URL with a numeric port keeps the port in the
  // path (split(":") takes the segment after the port colon).
  assert.equal(parseRepoPath("ssh://git@github.com:22/org/repo.git"), "22/org/repo");
});

// --- build_repo_lookup (ported) ---

test("buildRepoLookup resolves bare names and org/repo paths", () => {
  const repos = {
    chrome: { upstream: "https://github.com/RedHatInsights/insights-chrome.git" },
    rbac: { upstream: "https://gitlab.cee.redhat.com/team/rbac-service.git" },
  };
  const lookup = buildRepoLookup(repos);
  assert.equal(lookup.chrome, "chrome");
  assert.equal(lookup["RedHatInsights/insights-chrome"], "chrome");
  assert.equal(lookup.rbac, "rbac");
  assert.equal(lookup["team/rbac-service"], "rbac");
});

test("buildRepoLookup keeps entries without an upstream", () => {
  const lookup = buildRepoLookup({ simple: {} });
  assert.equal(lookup.simple, "simple");
  assert.equal(Object.keys(lookup).length, 1);
});

// --- match_repo_labels ---

test("matchRepoLabels returns canonical keys when every repo: label matches", () => {
  const lookup = buildRepoLookup({
    chrome: { upstream: "https://github.com/RedHatInsights/insights-chrome.git" },
  });
  assert.deepEqual(matchRepoLabels(["team-label", "repo:chrome"], lookup), ["chrome"]);
  assert.deepEqual(matchRepoLabels(["repo:RedHatInsights/insights-chrome"], lookup), ["chrome"]);
});

test("matchRepoLabels returns [] when any repo: label is unmatched", () => {
  const lookup = buildRepoLookup({ chrome: { upstream: "https://github.com/o/chrome.git" } });
  assert.deepEqual(matchRepoLabels(["repo:chrome", "repo:missing"], lookup), []);
});

test("matchRepoLabels returns [] when there is no repo: label at all", () => {
  assert.deepEqual(matchRepoLabels(["team-label", "needs-investigation"], {}), []);
  assert.deepEqual(matchRepoLabels([], {}), []);
});

test("labels naming inherited object properties never match — fail closed like Python dicts", () => {
  // `repo in lookup` would find toString/constructor/__proto__ on any plain
  // object and produce functions or null as "canonical keys"; the lookup
  // must be own-property only, matching Python's dict membership test.
  const lookup = buildRepoLookup({
    chrome: { upstream: "https://github.com/RedHatInsights/insights-chrome.git" },
  });
  for (const label of [
    "toString",
    "constructor",
    "__proto__",
    "hasOwnProperty",
    "valueOf",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toLocaleString",
  ]) {
    assert.deepEqual(matchRepoLabels([`repo:${label}`], lookup), [], label);
  }
  // A single reserved label poisons the whole match (Python fail-closed).
  assert.deepEqual(matchRepoLabels(["repo:chrome", "repo:toString"], lookup), []);
});

test("the own-property lookup keeps valid mappings and also guards plain-object lookups", () => {
  const lookup = buildRepoLookup({ chrome: { upstream: "https://github.com/o/chrome.git" } });
  assert.deepEqual(matchRepoLabels(["repo:chrome"], lookup), ["chrome"]);
  // Callers may hand in any Record; inherited members must not match there
  // either.
  const plain = { chrome: "chrome" };
  assert.deepEqual(matchRepoLabels(["repo:chrome"], plain), ["chrome"]);
  assert.deepEqual(matchRepoLabels(["repo:toString"], plain), []);
});

test("parseProjectRepos keeps an own __proto__ key as plain data without polluting prototypes", () => {
  const parsed = parseProjectRepos(
    '{"__proto__": {"polluted": true, "upstream": "https://github.com/org/repo.git"}, "plain": {"upstream": "https://gitlab.com/team/plain.git"}}',
  );
  // The reserved key survives as an own data property (Python dict parity)
  // instead of becoming a prototype write, and nothing leaks globally.
  assert.equal(Object.hasOwn(parsed, "__proto__"), true);
  assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
  assert.equal({}.polluted, undefined);
  // Ordinary entries keep resolving.
  assert.deepEqual(upstreamRepo("plain", parsed), {
    upstreamPath: "team/plain",
    host: "gitlab",
  });
  assert.deepEqual(upstreamRepo("nonexistent", parsed), { upstreamPath: "", host: "github" });
});

// --- project-repos.json loading ---

test("loadProjectRepos reads a project-repos.json map", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rehor-preflights-repos-"));
  const path = join(dir, "project-repos.json");
  writeFileSync(
    path,
    JSON.stringify({
      "app-interface": {
        url: "https://gitlab.cee.redhat.com/bot/app-interface.git",
        upstream: "https://gitlab.cee.redhat.com/service/app-interface.git",
        host: "gitlab",
      },
    }),
  );
  const repos = await loadProjectRepos(path);
  assert.deepEqual(repos, {
    "app-interface": {
      url: "https://gitlab.cee.redhat.com/bot/app-interface.git",
      upstream: "https://gitlab.cee.redhat.com/service/app-interface.git",
      host: "gitlab",
    },
  });
  assert.deepEqual(upstreamRepo("app-interface", repos), {
    upstreamPath: "service/app-interface",
    host: "gitlab",
  });
});

test("loadProjectRepos degrades to an empty map on unreadable or invalid files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rehor-preflights-repos-"));
  const missing = await loadProjectRepos(join(dir, "missing.json"));
  assert.deepEqual(missing, {});
  const invalid = join(dir, "invalid.json");
  writeFileSync(invalid, "{not json");
  assert.deepEqual(await loadProjectRepos(invalid), {});
  const nonObject = join(dir, "list.json");
  writeFileSync(nonObject, JSON.stringify(["a", "b"]));
  assert.deepEqual(await loadProjectRepos(nonObject), {});
});
