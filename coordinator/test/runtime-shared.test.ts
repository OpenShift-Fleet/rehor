import { describe, expect, it } from "vitest";

import type { TerminalWorkContext } from "../src/domain/terminal-state";
import { extractTaskResult, extractToolContext } from "../src/runtimes/shared";

describe.each(["mcp__bot-memory__", "bot-memory_"])("work context (%s)", (prefix) => {
  it("keeps status-selected work across unrelated lookup, notification, and memory calls", () => {
    const context: TerminalWorkContext = {};
    extractToolContext(
      `${prefix}bot_status_update`,
      { external_key: "ACTIVE", repo: "org/active", summary: "Active work" },
      context,
    );
    extractTaskResult('{"id":7,"external_key":"ACTIVE"}', context);
    for (const tool of ["task_get", "task_list", "slack_notify", "memory_search"]) {
      extractToolContext(
        `${prefix}${tool}`,
        {
          external_key: "OTHER",
          repo: "org/other",
          summary: "Other work",
          progress: { external_key: "OTHER", repo: "org/other" },
        },
        context,
      );
      extractTaskResult('{"id":99,"external_key":"OTHER"}', context);
      expect(context).toEqual({
        externalKey: "ACTIVE",
        repository: "org/active",
        summary: "Active work",
        taskId: 7,
      });
    }
  });

  it("selects outcome-reported work with generic identity ahead of legacy alias", () => {
    const context: TerminalWorkContext = { externalKey: "OLD", taskId: 7 };
    extractToolContext(
      `${prefix}task_outcome_report`,
      { external_key: "NEW", jira_key: "LEGACY", repo: "org/new", summary: "Outcome" },
      context,
    );
    expect(context).toEqual({
      externalKey: "NEW",
      repository: "org/new",
      summary: "Outcome",
      taskId: undefined,
    });
    extractTaskResult('{"id":7,"external_key":"OLD"}', context);
    expect(context.taskId).toBeUndefined();
    extractTaskResult([{ text: '{"id":8,"external_key":"NEW"}' }], context);
    expect(context.taskId).toBe(8);
  });

  it.each(["bot_status_update", "task_add", "task_update", "task_outcome_report", "task_remove"])(
    "accepts legacy identity from %s selection",
    (tool) => {
      const context: TerminalWorkContext = { externalKey: "OLD", taskId: 7 };
      extractToolContext(
        `${prefix}${tool}`,
        { jira_key: "LEGACY", repo: "org/legacy", summary: "Selected work" },
        context,
      );
      expect(context).toMatchObject({
        externalKey: "LEGACY",
        repository: "org/legacy",
        summary: "Selected work",
      });
      expect(context.taskId).toBeUndefined();
    },
  );

  it.each(["external_key", "jira_key"])(
    "fills missing context from nested progress %s without switching active work",
    (keyField) => {
      const context: TerminalWorkContext = {};
      extractToolContext(
        `${prefix}progress_store`,
        { progress: { [keyField]: "ACTIVE", repo: "org/active" } },
        context,
      );
      expect(context).toMatchObject({ externalKey: "ACTIVE", repository: "org/active" });
      context.repository = undefined;
      extractToolContext(
        `${prefix}progress_store`,
        {
          external_key: "OTHER",
          repo: "org/other",
          summary: "Other work",
          progress: { external_key: "OTHER", jira_key: "ACTIVE", repo: "org/other" },
        },
        context,
      );
      expect(context.externalKey).toBe("ACTIVE");
      expect(context.repository).toBeUndefined();
      expect(context.summary).toBeUndefined();
    },
  );

  it("prefers generic identity in saved progress", () => {
    const context: TerminalWorkContext = {};
    extractToolContext(
      `${prefix}progress_store`,
      { progress: { external_key: "GENERIC", jira_key: "LEGACY" } },
      context,
    );
    expect(context.externalKey).toBe("GENERIC");
  });
});

describe("task result correlation", () => {
  it.each(["external_key", "jira_key"])("correlates %s for resume lookups", (keyField) => {
    const context: TerminalWorkContext = { externalKey: "ACTIVE", taskId: 7 };
    for (const idField of ["id", "task_id"]) {
      context.taskId = 7;
      extractTaskResult(JSON.stringify({ [idField]: 99, [keyField]: "OTHER" }), context);
      expect(context.taskId).toBe(7);
      extractTaskResult(JSON.stringify({ [idField]: 8, [keyField]: "ACTIVE" }), context);
      expect(context.taskId).toBe(8);
    }
  });

  it("preserves progress results without identity", () => {
    const context: TerminalWorkContext = { externalKey: "ACTIVE" };
    extractTaskResult('{"task_id":7,"cycle_type":"pr_review"}', context);
    expect(context.taskId).toBe(7);
  });

  it("ignores context-shaped input from non-memory tools and spoofed suffixes", () => {
    const context: TerminalWorkContext = {};
    for (const name of ["Bash", "mcp__other__task_add", "bot-memory_not_task_add"]) {
      extractToolContext(
        name,
        { external_key: "OTHER", repo: "org/other", summary: "Other work" },
        context,
      );
    }
    expect(context).toEqual({});
  });
});
