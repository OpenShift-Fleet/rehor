import { z } from "zod";
import { createPreflightRegistry, definePreflight } from "../dist/index.js";

/**
 * Fixture preflights shaped like the Python preflights being ported
 * (REHOR-257 registers the real implementations). `gh-pr-status` has no
 * required inputs; `jira-kanban` requires `project`/`label` with optional
 * `statuses`/`jql_extra`/`email`/`interrupted_retry_minutes`; `onboarding`
 * requires `label`.
 */

export const ghPrStatus = definePreflight({
  id: "gh-pr-status",
  input: z.strictObject({}),
  run: async () => ({ status: "skip", content: "no active PRs" }),
});

export const glMrStatus = definePreflight({
  id: "gl-mr-status",
  input: z.strictObject({}),
  run: async () => ({ status: "skip", content: "no active MRs" }),
});

export const jiraKanban = definePreflight({
  id: "jira-kanban",
  input: z.strictObject({
    project: z.string(),
    label: z.string(),
    statuses: z.array(z.string()).default(["New", "Backlog", "To Do"]),
    jql_extra: z.string().optional(),
    email: z.string().optional(),
    interrupted_retry_minutes: z.number().default(30),
  }),
  run: async (ctx, params) => ({
    status: "start",
    content: `kanban ${ctx.instanceId} ${params.project}`,
  }),
});

export const onboarding = definePreflight({
  id: "onboarding",
  input: z.strictObject({ label: z.string() }),
  run: async () => ({ status: "skip", content: "no onboarding tickets" }),
});

export const allFixtures = [ghPrStatus, glMrStatus, jiraKanban, onboarding];

/** Registry with every fixture registered. */
export const fixtureRegistry = createPreflightRegistry(allFixtures);
