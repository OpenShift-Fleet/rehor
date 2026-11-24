import assert from "node:assert/strict";
import test from "node:test";
import { createPreflightRunContext } from "../dist/index.js";
import { createPopulatedRegistry } from "../dist/preflights/index.js";
import { issueComments } from "../dist/preflights/jira-common/shapes.js";
import { runOnboardingPreflight } from "../dist/preflights/onboarding/index.js";
import {
  AUTO_ADVANCE_STEPS,
  anyPrMrMerged,
  fmtOnboardingCandidate,
  getOnboardingLabel,
  hasNewOnboardingFeedback,
  isBlocked,
  phaseTicketDone,
} from "../dist/preflights/onboarding/phases.js";
import { activeTask, createTestContext, jsonResponse } from "./jira-fixtures.mjs";

const registry = createPopulatedRegistry();
const onboarding = registry.get("onboarding");

const runOnboarding = (ctx, withParams = {}, deps) =>
  runOnboardingPreflight(
    ctx,
    onboarding.input.parse({ label: "rehor-ai-onboarding-bot", ...withParams }),
    deps,
  );

const onboardingIssue = (labels, comments = []) => ({
  fields: { status: { name: "In Progress" }, labels },
  comments,
});

// --- hasNewOnboardingFeedback (the onboarding variant: any new comment) ---

test("feedback detected with a comment newer than last_addressed", () => {
  const comments = [
    { created: "2026-07-01T10:00:00", body: "Here are the answers to your questions" },
  ];
  assert.equal(hasNewOnboardingFeedback(comments, "2026-06-30T10:00:00"), true);
});

test("first comment with no last_addressed counts as feedback", () => {
  const comments = [{ created: "2026-07-01T10:00:00", body: "Hello" }];
  assert.equal(hasNewOnboardingFeedback(comments, ""), true);
});

test("no feedback when the comment is old", () => {
  const comments = [{ created: "2026-06-29T10:00:00", body: "Old comment" }];
  assert.equal(hasNewOnboardingFeedback(comments, "2026-06-30T10:00:00"), false);
});

test("no feedback when there are no comments", () => {
  assert.equal(hasNewOnboardingFeedback([], "2026-06-30T10:00:00"), false);
});

// --- issueComments (the Python _get_comments parity) ---

test("issue comments read from the merged fields.comment.comments", () => {
  const issue = { fields: { comment: { comments: [{ body: "b" }] } } };
  assert.deepEqual(issueComments(issue), [{ body: "b" }]);
});

test("issue comments read from a top-level comments array (MCP shape tolerance)", () => {
  const issue = { comments: [{ body: "a" }] };
  assert.deepEqual(issueComments(issue), [{ body: "a" }]);
});

test("issue comments of a missing issue are empty", () => {
  assert.deepEqual(issueComments(null), []);
});

// --- blocked / onboarding-label helpers ---

test("is_blocked detects the onboarding:blocked label", () => {
  assert.equal(isBlocked({ labels: ["onboarding:requirements", "onboarding:blocked"] }), true);
  assert.equal(isBlocked({ fields: { labels: ["onboarding:requirements"] } }), false);
  assert.equal(isBlocked(null), false);
});

test("get_onboarding_label returns the step label and ignores blocked", () => {
  assert.equal(
    getOnboardingLabel({ labels: ["rehor-ai-onboarding-bot", "onboarding:requirements"] }),
    "onboarding:requirements",
  );
  assert.equal(getOnboardingLabel({ labels: ["onboarding:blocked"] }), null);
  assert.equal(getOnboardingLabel(null), null);
  assert.equal(getOnboardingLabel({ labels: ["rehor-ai-onboarding-bot"] }), null);
});

// --- phase tickets ---

const stubJira = (issues) => ({
  getIssue: async (key) => {
    const issue = issues[key];
    if (issue === undefined) {
      throw new Error(`no such issue: ${key}`);
    }
    return issue;
  },
});

test("phase ticket done returns true", async () => {
  const jira = stubJira({ "REHOR-101": { fields: { status: { name: "Done" } } } });
  const task = { metadata: { phase_tickets: { phase1: "REHOR-101" } } };
  assert.equal(await phaseTicketDone(task, "scaffolding-pr", jira), true);
});

test("phase ticket open returns false", async () => {
  const jira = stubJira({ "REHOR-102": { fields: { status: { name: "In Progress" } } } });
  const task = { metadata: { phase_tickets: { phase2: "REHOR-102" } } };
  assert.equal(await phaseTicketDone(task, "konflux-mr", jira), false);
});

test("unknown step has no phase ticket", async () => {
  const task = { metadata: { phase_tickets: { phase1: "REHOR-101" } } };
  assert.equal(await phaseTicketDone(task, "unknown-step", stubJira({})), false);
});

test("task without phase tickets returns false", async () => {
  assert.equal(await phaseTicketDone({ metadata: {} }, "scaffolding-pr", stubJira({})), false);
});

test("a failing phase-ticket fetch propagates (fail-closed, no silent false)", async () => {
  const task = { metadata: { phase_tickets: { phase1: "REHOR-101" } } };
  await assert.rejects(() => phaseTicketDone(task, "scaffolding-pr", stubJira({})));
});

// --- anyPrMrMerged (phase-aware merge detection) ---

test("merged check skipped when the phase ticket is already done", async () => {
  const jira = stubJira({ "REHOR-101": { fields: { status: { name: "Done" } } } });
  const task = {
    metadata: {
      phase_tickets: { phase1: "REHOR-101" },
      prs: [{ repo: "org/repo", number: 1, host: "github" }],
    },
  };
  let called = false;
  const result = await anyPrMrMerged(task, "scaffolding-pr", {
    jira,
    repos: {},
    isPrMerged: async () => {
      called = true;
      return true;
    },
  });
  assert.equal(result, false);
  assert.equal(called, false);
});

test("konflux-mr step ignores old github PRs", async () => {
  const jira = stubJira({ "REHOR-102": { fields: { status: { name: "In Progress" } } } });
  const task = {
    metadata: {
      phase_tickets: { phase2: "REHOR-102" },
      prs: [{ repo: "org/repo", number: 1, host: "github" }],
      mrs: [],
    },
  };
  assert.equal(await anyPrMrMerged(task, "konflux-mr", { jira, repos: {} }), false);
});

test("app-interface-mr step checks only the latest gitlab MR", async () => {
  const jira = stubJira({ "REHOR-103": { fields: { status: { name: "In Progress" } } } });
  const task = {
    metadata: {
      phase_tickets: { phase3: "REHOR-103" },
      prs: [{ repo: "org/scaffolding", number: 1, host: "github" }],
      mrs: [
        { repo: "releng/konflux-release-data", number: 10, host: "gitlab" },
        { repo: "service/app-interface", number: 20, host: "gitlab" },
      ],
    },
  };
  const calls = [];
  const result = await anyPrMrMerged(task, "app-interface-mr", {
    jira,
    repos: {},
    isPrMerged: async (host, upstreamPath, number) => {
      calls.push({ host, upstreamPath, number });
      return true;
    },
  });
  assert.equal(result, true);
  assert.deepEqual(calls, [{ host: "gitlab", upstreamPath: "service/app-interface", number: 20 }]);
});

test("app-interface-mr step does not false-positive on an old merged konflux MR", async () => {
  const jira = stubJira({ "REHOR-103": { fields: { status: { name: "In Progress" } } } });
  const task = {
    metadata: {
      phase_tickets: { phase3: "REHOR-103" },
      mrs: [
        { repo: "releng/konflux-release-data", number: 10, host: "gitlab" },
        { repo: "service/app-interface", number: 20, host: "gitlab" },
      ],
    },
  };
  const result = await anyPrMrMerged(task, "app-interface-mr", {
    jira,
    repos: {},
    isPrMerged: async (_host, _upstreamPath, number) => number === 10,
  });
  assert.equal(result, false);
});

test("auto-advance steps are scaffolding-pr, konflux-mr, app-interface-mr", () => {
  assert.deepEqual([...AUTO_ADVANCE_STEPS], ["scaffolding-pr", "konflux-mr", "app-interface-mr"]);
});

// --- candidate formatting ---

test("onboarding candidates render key, status, summary, and labels", () => {
  const issue = {
    key: "REHOR-20",
    fields: {
      summary: "Onboard team Foo",
      status: { name: "New" },
      labels: ["rehor-ai-onboarding-bot"],
    },
  };
  assert.equal(
    fmtOnboardingCandidate(issue),
    "  REHOR-20 [New] Onboard team Foo (labels: rehor-ai-onboarding-bot)",
  );
});

// --- run() decision logic ---

test("active task with new feedback returns start", async () => {
  const ctx = createTestContext({
    tasks: [
      activeTask({
        external_key: "REHOR-10",
        repo: "",
        last_addressed: "2026-06-30T10:00:00",
        metadata: { step: "requirements" },
      }),
    ],
    issues: {
      "REHOR-10": onboardingIssue(
        ["rehor-ai-onboarding-bot", "onboarding:requirements"],
        [
          {
            created: "2026-07-01T10:00:00",
            body: "Our team name is Platform and we want to onboard service X",
            author: { displayName: "Human User" },
          },
        ],
      ),
    },
    search: async () => [],
  });
  const result = await runOnboarding(ctx);
  assert.equal(result.status, "start");
  assert.match(result.content, /HAS NEW JIRA FEEDBACK/);
  assert.match(result.content, /ACTIVE ONBOARDING TASKS \(1\)/);
  assert.match(result.content, /onboarding_step: requirements \(label: onboarding:requirements\)/);
});

test("active task without feedback and no candidates returns skip", async () => {
  const ctx = createTestContext({
    tasks: [
      activeTask({
        external_key: "REHOR-10",
        repo: "",
        last_addressed: "2026-07-01T12:00:00",
        metadata: { step: "requirements" },
      }),
    ],
    issues: {
      "REHOR-10": onboardingIssue(
        ["rehor-ai-onboarding-bot", "onboarding:requirements"],
        [
          {
            created: "2026-07-01T10:00:00",
            body: "Already addressed comment",
            author: { displayName: "Human User" },
          },
        ],
      ),
    },
    search: async () => [],
  });
  const result = await runOnboarding(ctx);
  assert.equal(result.status, "skip");
});

test("no active tasks with candidates returns start", async () => {
  const ctx = createTestContext({
    tasks: [],
    search: async () => [
      {
        key: "REHOR-20",
        fields: {
          summary: "Onboard team Foo",
          status: { name: "New" },
          labels: ["rehor-ai-onboarding-bot"],
        },
      },
    ],
  });
  const result = await runOnboarding(ctx);
  assert.equal(result.status, "start");
  assert.match(result.content, /REHOR-20/);
  assert.match(result.content, /NEW ONBOARDING CANDIDATES \(1\)/);
});

test("no active tasks and no candidates returns skip", async () => {
  const ctx = createTestContext({ tasks: [], search: async () => [] });
  const result = await runOnboarding(ctx);
  assert.equal(result.status, "skip");
  assert.match(result.content, /No active tasks and no new candidates/);
  assert.match(result.content, /CAPACITY: 0\/10 active tasks/);
});

test("candidate search uses the configured project and quoted label", async () => {
  const jqls = [];
  const ctx = createTestContext({
    tasks: [],
    search: async (jql) => {
      jqls.push(jql);
      return [];
    },
  });
  await runOnboarding(ctx, { label: "hcc-ai-onboarding", project: "RHCLOUD" });
  assert.equal(jqls.length, 1);
  assert.match(jqls[0], /project = RHCLOUD/);
  assert.match(jqls[0], /labels = "hcc-ai-onboarding"/);
  assert.match(jqls[0], /status in \("New", "Backlog", "To Do", "Open"\)/);
});

test("blocked task is skipped with the intervention note", async () => {
  const ctx = createTestContext({
    tasks: [
      activeTask({ external_key: "REHOR-30", repo: "", metadata: { step: "scaffolding-pr" } }),
    ],
    issues: {
      "REHOR-30": onboardingIssue([
        "rehor-ai-onboarding-bot",
        "onboarding:scaffolding-pr",
        "onboarding:blocked",
      ]),
    },
    search: async () => [],
  });
  const result = await runOnboarding(ctx);
  assert.equal(result.status, "skip");
  assert.match(result.content, /BLOCKED — requires Rehor team intervention, skipping/);
});

test("merged PR at an auto-advance step returns start", async () => {
  const ctx = createTestContext({
    tasks: [
      activeTask({
        external_key: "REHOR-40",
        repo: "",
        last_addressed: "2026-07-01T12:00:00",
        metadata: {
          step: "scaffolding-pr",
          prs: [{ repo: "org/repo", number: 1, host: "github" }],
        },
      }),
    ],
    issues: {
      "REHOR-40": onboardingIssue(["rehor-ai-onboarding-bot", "onboarding:scaffolding-pr"]),
    },
    search: async () => [],
  });
  const calls = [];
  const result = await runOnboarding(
    ctx,
    {},
    {
      isPrMerged: async (host, upstreamPath, number) => {
        calls.push({ host, upstreamPath, number });
        return true;
      },
    },
  );
  assert.equal(result.status, "start");
  assert.match(result.content, /PR\/MR MERGED — ADVANCE PHASE \(current: scaffolding-pr\)/);
  assert.deepEqual(calls, [{ host: "github", upstreamPath: "org/repo", number: 1 }]);
});

test("unmerged PR at an auto-advance step waits", async () => {
  const ctx = createTestContext({
    tasks: [
      activeTask({
        external_key: "REHOR-40",
        repo: "",
        last_addressed: "2026-07-01T12:00:00",
        metadata: {
          step: "scaffolding-pr",
          prs: [{ repo: "org/repo", number: 1, host: "github" }],
        },
      }),
    ],
    issues: {
      "REHOR-40": onboardingIssue(["rehor-ai-onboarding-bot", "onboarding:scaffolding-pr"]),
    },
    search: async () => [],
  });
  const result = await runOnboarding(ctx, {}, { isPrMerged: async () => false });
  assert.equal(result.status, "skip");
  assert.match(result.content, /waiting for PR\/MR merge \(current: scaffolding-pr\)/);
});

test("tekton-setup is not an auto-advance step — no merge check runs", async () => {
  const ctx = createTestContext({
    tasks: [
      activeTask({
        external_key: "REHOR-60",
        repo: "",
        last_addressed: "2026-07-01T12:00:00",
        metadata: {
          step: "tekton-setup",
          prs: [{ repo: "org/repo", number: 1, host: "github" }],
          mrs: [{ repo: "releng/konflux-release-data", number: 10, host: "gitlab" }],
        },
      }),
    ],
    issues: {
      "REHOR-60": onboardingIssue(["rehor-ai-onboarding-bot", "onboarding:tekton-setup"]),
    },
    search: async () => [],
  });
  const result = await runOnboarding(
    ctx,
    {},
    {
      isPrMerged: async () => {
        throw new Error("should not be called");
      },
    },
  );
  assert.equal(result.status, "skip");
  assert.doesNotMatch(result.content, /PR\/MR MERGED/);
});

test("konflux-mr merged with an open phase ticket returns start", async () => {
  const ctx = createTestContext({
    tasks: [
      activeTask({
        external_key: "REHOR-70",
        status: "pr_open",
        repo: "",
        last_addressed: "2026-07-01T12:00:00",
        metadata: {
          step: "konflux-mr",
          phase_tickets: { phase2: "REHOR-702" },
          mrs: [{ repo: "releng/konflux-release-data", number: 10, host: "gitlab" }],
        },
      }),
    ],
    issues: {
      "REHOR-70": onboardingIssue(["rehor-ai-onboarding-bot", "onboarding:konflux-mr"]),
      "REHOR-702": { fields: { status: { name: "In Progress" } }, comments: [] },
    },
    search: async () => [],
  });
  const calls = [];
  const result = await runOnboarding(
    ctx,
    {},
    {
      isPrMerged: async (host, upstreamPath, number) => {
        calls.push({ host, upstreamPath, number });
        return true;
      },
    },
  );
  assert.equal(result.status, "start");
  assert.match(result.content, /PR\/MR MERGED — ADVANCE PHASE \(current: konflux-mr\)/);
  assert.deepEqual(calls, [
    { host: "gitlab", upstreamPath: "releng/konflux-release-data", number: 10 },
  ]);
});

// --- the default merge check: the package's clients on the proxy route ---
// The registered preflight composes the GitHub and GitLab clients from
// ctx.proxy (no gh/glab subprocesses, no CLI credentials); these tests run
// it against fixture fetches — zero subprocess, zero network.

/** Proxy-route fetch router: GitHub GraphQL PR state + GitLab MR state. */
const proxyFetch =
  ({ prState = "OPEN", mrState = "opened", githubStatus = 200, gitlabStatus = 200 } = {}) =>
  async (url, init) => {
    if (url === "https://proxy.test/github/graphql") {
      if (githubStatus !== 200) return jsonResponse({ message: "Not Found" }, githubStatus);
      return jsonResponse({
        data: {
          repository: {
            pullRequest:
              prState === null
                ? null
                : {
                    state: prState,
                    mergeable: "MERGEABLE",
                    reviews: { nodes: [] },
                    statusCheckRollup: { contexts: { nodes: [] } },
                  },
          },
        },
      });
    }
    const mr =
      /^https:\/\/proxy\.test\/gitlab\/api\/v4\/projects\/([^/]+)\/merge_requests\/(\d+)$/.exec(
        url,
      );
    if (mr) {
      if (gitlabStatus !== 200) return jsonResponse({ message: "Not Found" }, gitlabStatus);
      assert.equal(init.method, "GET");
      return jsonResponse({ state: mrState });
    }
    throw new Error(`unexpected proxy fetch: ${url}`);
  };

/** Run the registered preflight (the composition of the default merge check). */
const runRegistered = (ctx) =>
  onboarding.run(ctx, onboarding.input.parse({ label: "rehor-ai-onboarding-bot" }));

test("default merge check reads the GitHub PR state through the proxy route", async () => {
  const ctx = createTestContext({
    tasks: [
      activeTask({
        external_key: "REHOR-41",
        repo: "",
        last_addressed: "2026-07-01T12:00:00",
        metadata: {
          step: "scaffolding-pr",
          prs: [{ repo: "org/repo", number: 1, host: "github" }],
        },
      }),
    ],
    issues: {
      "REHOR-41": onboardingIssue(["rehor-ai-onboarding-bot", "onboarding:scaffolding-pr"]),
    },
    search: async () => [],
    proxy: { baseUrl: "https://proxy.test", fetch: proxyFetch({ prState: "MERGED" }) },
  });
  const result = await runRegistered(ctx);
  assert.equal(result.status, "start");
  assert.match(result.content, /PR\/MR MERGED — ADVANCE PHASE \(current: scaffolding-pr\)/);
});

test("default merge check reads the GitLab MR state through the proxy route", async () => {
  const ctx = createTestContext({
    tasks: [
      activeTask({
        external_key: "REHOR-42",
        repo: "",
        last_addressed: "2026-07-01T12:00:00",
        metadata: {
          step: "konflux-mr",
          mrs: [{ repo: "releng/konflux-release-data", number: 10, host: "gitlab" }],
        },
      }),
    ],
    issues: {
      "REHOR-42": onboardingIssue(["rehor-ai-onboarding-bot", "onboarding:konflux-mr"]),
    },
    search: async () => [],
    proxy: { baseUrl: "https://proxy.test", fetch: proxyFetch({ mrState: "merged" }) },
  });
  const result = await runRegistered(ctx);
  assert.equal(result.status, "start");
  assert.match(result.content, /PR\/MR MERGED — ADVANCE PHASE \(current: konflux-mr\)/);
});

test("an unwired proxy route errors when a merge check is needed", async () => {
  const ctx = createTestContext({
    tasks: [
      activeTask({
        external_key: "REHOR-43",
        repo: "",
        last_addressed: "2026-07-01T12:00:00",
        metadata: {
          step: "scaffolding-pr",
          prs: [{ repo: "org/repo", number: 1, host: "github" }],
        },
      }),
    ],
    issues: {
      "REHOR-43": onboardingIssue(["rehor-ai-onboarding-bot", "onboarding:scaffolding-pr"]),
    },
    search: async () => [],
  });
  const result = await runRegistered(ctx);
  assert.equal(result.status, "error");
  assert.match(result.content, /auth proxy route/);
  assert.match(result.content, /not wired/);
});

test("a per-PR fetch failure during the merge check reports not-merged", async () => {
  // Python try/except parity: a failed gh/glab fetch meant "not merged".
  const ctx = createTestContext({
    tasks: [
      activeTask({
        external_key: "REHOR-44",
        repo: "",
        last_addressed: "2026-07-01T12:00:00",
        metadata: {
          step: "scaffolding-pr",
          prs: [{ repo: "org/repo", number: 1, host: "github" }],
        },
      }),
    ],
    issues: {
      "REHOR-44": onboardingIssue(["rehor-ai-onboarding-bot", "onboarding:scaffolding-pr"]),
    },
    search: async () => [],
    proxy: { baseUrl: "https://proxy.test", fetch: proxyFetch({ githubStatus: 404 }) },
  });
  const result = await runRegistered(ctx);
  assert.equal(result.status, "skip");
  assert.match(result.content, /waiting for PR\/MR merge \(current: scaffolding-pr\)/);
});

test("a per-MR fetch failure during the merge check reports not-merged", async () => {
  // Per-item 404 stays advisory not-merged (deleted or mis-referenced MR):
  // the merge check is advisory, and the phase sub-ticket is the source of
  // truth, so one missing MR must not abort the onboarding run.
  const ctx = createTestContext({
    tasks: [
      activeTask({
        external_key: "REHOR-45",
        repo: "",
        last_addressed: "2026-07-01T12:00:00",
        metadata: {
          step: "app-interface-mr",
          mrs: [{ repo: "service/app-interface", number: 20, host: "gitlab" }],
        },
      }),
    ],
    issues: {
      "REHOR-45": onboardingIssue(["rehor-ai-onboarding-bot", "onboarding:app-interface-mr"]),
    },
    search: async () => [],
    proxy: { baseUrl: "https://proxy.test", fetch: proxyFetch({ gitlabStatus: 404 }) },
  });
  const result = await runRegistered(ctx);
  assert.equal(result.status, "skip");
  assert.match(result.content, /waiting for PR\/MR merge \(current: app-interface-mr\)/);
});

test("a GitLab 5xx during the merge check is an execution error, not a healthy wait", async () => {
  // Spike compliance (docs/preflight-rework-spike-input.md: an unavailable
  // route is a preflight execution error, never a silent skip): the
  // previously accepted per-item 500 → "not merged" behavior is withdrawn.
  // A shared upstream outage must not masquerade as a healthy "waiting for
  // PR/MR merge" while the merge state is actually unknown — only a 404
  // (the item itself missing) stays advisory not-merged.
  const ctx = createTestContext({
    tasks: [
      activeTask({
        external_key: "REHOR-45",
        repo: "",
        last_addressed: "2026-07-01T12:00:00",
        metadata: {
          step: "app-interface-mr",
          mrs: [{ repo: "service/app-interface", number: 20, host: "gitlab" }],
        },
      }),
    ],
    issues: {
      "REHOR-45": onboardingIssue(["rehor-ai-onboarding-bot", "onboarding:app-interface-mr"]),
    },
    search: async () => [],
    proxy: { baseUrl: "https://proxy.test", fetch: proxyFetch({ gitlabStatus: 500 }) },
  });
  const result = await runRegistered(ctx);
  assert.equal(result.status, "error");
  assert.match(result.content, /HTTP 500/);
  assert.doesNotMatch(result.content, /waiting for PR\/MR merge/);
});

test("a GitHub 503 during the merge check is an execution error", async () => {
  const ctx = createTestContext({
    tasks: [
      activeTask({
        external_key: "REHOR-47",
        repo: "",
        last_addressed: "2026-07-01T12:00:00",
        metadata: {
          step: "scaffolding-pr",
          prs: [{ repo: "org/repo", number: 1, host: "github" }],
        },
      }),
    ],
    issues: {
      "REHOR-47": onboardingIssue(["rehor-ai-onboarding-bot", "onboarding:scaffolding-pr"]),
    },
    search: async () => [],
    proxy: { baseUrl: "https://proxy.test", fetch: proxyFetch({ githubStatus: 503 }) },
  });
  const result = await runRegistered(ctx);
  assert.equal(result.status, "error");
  assert.match(result.content, /HTTP 503/);
});

test("a GitHub auth rejection (401) during the merge check is an execution error", async () => {
  const ctx = createTestContext({
    tasks: [
      activeTask({
        external_key: "REHOR-48",
        repo: "",
        last_addressed: "2026-07-01T12:00:00",
        metadata: {
          step: "scaffolding-pr",
          prs: [{ repo: "org/repo", number: 1, host: "github" }],
        },
      }),
    ],
    issues: {
      "REHOR-48": onboardingIssue(["rehor-ai-onboarding-bot", "onboarding:scaffolding-pr"]),
    },
    search: async () => [],
    proxy: { baseUrl: "https://proxy.test", fetch: proxyFetch({ githubStatus: 401 }) },
  });
  const result = await runRegistered(ctx);
  assert.equal(result.status, "error");
  assert.match(result.content, /401/);
});

test("a GitLab auth rejection (403) during the merge check is an execution error", async () => {
  const ctx = createTestContext({
    tasks: [
      activeTask({
        external_key: "REHOR-49",
        repo: "",
        last_addressed: "2026-07-01T12:00:00",
        metadata: {
          step: "konflux-mr",
          mrs: [{ repo: "releng/konflux-release-data", number: 10, host: "gitlab" }],
        },
      }),
    ],
    issues: {
      "REHOR-49": onboardingIssue(["rehor-ai-onboarding-bot", "onboarding:konflux-mr"]),
    },
    search: async () => [],
    proxy: { baseUrl: "https://proxy.test", fetch: proxyFetch({ gitlabStatus: 403 }) },
  });
  const result = await runRegistered(ctx);
  assert.equal(result.status, "error");
  assert.match(result.content, /403/);
});

test("a network failure during the merge check is an execution error", async () => {
  const ctx = createTestContext({
    tasks: [
      activeTask({
        external_key: "REHOR-50",
        repo: "",
        last_addressed: "2026-07-01T12:00:00",
        metadata: {
          step: "scaffolding-pr",
          prs: [{ repo: "org/repo", number: 1, host: "github" }],
        },
      }),
    ],
    issues: {
      "REHOR-50": onboardingIssue(["rehor-ai-onboarding-bot", "onboarding:scaffolding-pr"]),
    },
    search: async () => [],
    proxy: {
      baseUrl: "https://proxy.test",
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    },
  });
  const result = await runRegistered(ctx);
  assert.equal(result.status, "error");
  assert.doesNotMatch(result.content, /waiting for PR\/MR merge/);
});

test("a timeout during the merge check is an execution error", async () => {
  const ctx = createTestContext({
    tasks: [
      activeTask({
        external_key: "REHOR-51",
        repo: "",
        last_addressed: "2026-07-01T12:00:00",
        metadata: {
          step: "konflux-mr",
          mrs: [{ repo: "releng/konflux-release-data", number: 10, host: "gitlab" }],
        },
      }),
    ],
    issues: {
      "REHOR-51": onboardingIssue(["rehor-ai-onboarding-bot", "onboarding:konflux-mr"]),
    },
    search: async () => [],
    proxy: {
      baseUrl: "https://proxy.test",
      fetch: async () => {
        throw Object.assign(new Error("The operation was aborted due to timeout"), {
          name: "TimeoutError",
        });
      },
    },
  });
  const result = await runRegistered(ctx);
  assert.equal(result.status, "error");
  assert.doesNotMatch(result.content, /waiting for PR\/MR merge/);
});

test("a missing GitHub PR is not merged", async () => {
  // gh pr view on a nonexistent PR exits non-zero → Python reported false.
  const ctx = createTestContext({
    tasks: [
      activeTask({
        external_key: "REHOR-46",
        repo: "",
        last_addressed: "2026-07-01T12:00:00",
        metadata: {
          step: "scaffolding-pr",
          prs: [{ repo: "org/repo", number: 1, host: "github" }],
        },
      }),
    ],
    issues: {
      "REHOR-46": onboardingIssue(["rehor-ai-onboarding-bot", "onboarding:scaffolding-pr"]),
    },
    search: async () => [],
    proxy: { baseUrl: "https://proxy.test", fetch: proxyFetch({ prState: null }) },
  });
  const result = await runRegistered(ctx);
  assert.equal(result.status, "skip");
  assert.match(result.content, /waiting for PR\/MR merge \(current: scaffolding-pr\)/);
});

test("phase tickets line renders when the task metadata has them", async () => {
  const ctx = createTestContext({
    tasks: [
      activeTask({
        external_key: "REHOR-80",
        repo: "",
        last_addressed: "2026-07-01T12:00:00",
        metadata: {
          step: "requirements",
          phase_tickets: { phase1: "REHOR-801", phase3: "REHOR-803" },
        },
      }),
    ],
    issues: {
      "REHOR-80": onboardingIssue(["rehor-ai-onboarding-bot", "onboarding:requirements"]),
    },
    search: async () => [],
  });
  const result = await runOnboarding(ctx);
  assert.equal(result.status, "skip");
  assert.match(result.content, /phase_tickets: P1=REHOR-801 P2=\? P3=REHOR-803/);
});

test("run records onboarding counts on the run state", async () => {
  const ctx = createTestContext({
    tasks: [
      activeTask({
        external_key: "REHOR-10",
        repo: "",
        last_addressed: "2026-06-30T10:00:00",
        metadata: { step: "requirements" },
      }),
    ],
    issues: {
      "REHOR-10": onboardingIssue(
        ["rehor-ai-onboarding-bot", "onboarding:requirements"],
        [
          {
            created: "2026-07-01T10:00:00",
            body: "New input",
            author: { displayName: "Human User" },
          },
        ],
      ),
    },
    search: async () => [
      { key: "REHOR-20", fields: { summary: "s", status: { name: "New" }, labels: [] } },
    ],
  });
  await runOnboarding(ctx);
  assert.equal(ctx.state.get("active_onboarding_count"), 1);
  assert.equal(ctx.state.get("candidate_count"), 1);
});

test("task PRs are listed in the task block", async () => {
  const ctx = createTestContext({
    tasks: [
      activeTask({
        external_key: "REHOR-90",
        repo: "",
        last_addressed: "2026-07-01T12:00:00",
        metadata: {
          step: "requirements",
          prs: [{ repo: "org/repo", number: 7, host: "github" }],
        },
      }),
    ],
    issues: {
      "REHOR-90": onboardingIssue(["rehor-ai-onboarding-bot", "onboarding:requirements"]),
    },
    search: async () => [],
  });
  const result = await runOnboarding(ctx);
  assert.equal(result.status, "skip");
  assert.match(result.content, /pr: github #7 \(org\/repo\)/);
});

// --- adapted: jira failures are error results, never silent degradation ---

test("jira failures map to an error result", async () => {
  const ctx = createPreflightRunContext({
    instanceId: "test-instance",
    memory: { baseUrl: "http://memory.test", fetch: async () => jsonResponse({ items: [] }) },
    jira: {
      baseUrl: "https://proxy.test",
      fetch: async () => jsonResponse({ error: "boom" }, 500),
    },
  });
  const result = await onboarding.run(
    ctx,
    onboarding.input.parse({ label: "rehor-ai-onboarding-bot" }),
  );
  assert.equal(result.status, "error");
  assert.match(result.content, /500/);
});

test("onboarding without a wired jira client returns an error result", async () => {
  const ctx = createPreflightRunContext({
    instanceId: "test-instance",
    memory: { baseUrl: "http://memory.test", fetch: async () => jsonResponse({ items: [] }) },
  });
  const result = await onboarding.run(
    ctx,
    onboarding.input.parse({ label: "rehor-ai-onboarding-bot" }),
  );
  assert.equal(result.status, "error");
  assert.match(result.content, /jira client not wired/);
});
