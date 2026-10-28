import { describe, expect, it } from "vitest";
import {
  coordinatorTranscript,
  coordinatorEvent as event,
  jsonl,
  viewerAnswer,
} from "./test/transcript-fixtures";
import { parseTranscript } from "./transcript";

describe("parseTranscript", () => {
  it("renders flattened coordinator records without runtimeId or metadata noise", () => {
    const entries = parseTranscript(coordinatorTranscript);
    expect(entries.map((entry) => entry.blockType)).toEqual([
      "thinking",
      "text",
      "tool_use",
      "tool_result",
    ]);
    expect(entries[1]).toMatchObject({ role: "assistant", content: viewerAnswer, isLarge: true });
    expect(entries[2]).toMatchObject({ label: "inspect", content: '{\n  "path": "example.ts"\n}' });
    expect(entries[3].content).toBe("Synthetic inspection passed");
  });

  it("replaces text/reasoning snapshots, including repeated and corrected reconciliation", () => {
    const entries = parseTranscript(
      jsonl([
        event(1, "model", { phase: "text", partId: "answer", text: "Hello", delta: "Hello" }),
        event(2, "model", { phase: "reasoning", partId: "plan", text: "Check" }),
        event(3, "model", {
          phase: "text",
          partId: "answer",
          text: "Hello world",
          delta: " world",
        }),
        event(4, "model", {
          phase: "reasoning",
          partId: "plan",
          text: "Check inputs",
          delta: " inputs",
        }),
        event(5, "model", { phase: "text", partId: "answer", text: "Hello world" }),
        event(6, "model", { phase: "text", partId: "answer", text: "Corrected" }),
      ]),
    );
    expect(entries.map((entry) => entry.content)).toEqual(["Corrected", "Check inputs"]);
  });

  it("appends delta-only events, deduplicates replayed event IDs, then accepts full snapshot", () => {
    const delta = event(2, "model", { phase: "text", partId: "answer", delta: " world" });
    expect(
      parseTranscript(
        jsonl([
          event(1, "model", { phase: "text", partId: "answer", delta: "Hello" }),
          delta,
          delta,
        ]),
      )[0].content,
    ).toBe("Hello world");
    expect(
      parseTranscript(
        jsonl([delta, event(3, "model", { phase: "text", partId: "answer", text: "Hello world" })]),
      )[0].content,
    ).toBe("Hello world");
  });

  it("scopes reused model and tool IDs by session, run, and attempt", () => {
    const records: unknown[] = [];
    const scopes = [
      {},
      { runtimeSessionRef: "child" },
      { runId: "other-run" },
      { attemptId: "other-attempt" },
    ];
    scopes.forEach((scope, index) => {
      records.push(
        event(
          index * 3,
          "model",
          { phase: "text", partId: "same", text: `Answer ${index}` },
          scope,
        ),
        event(
          index * 3 + 1,
          "tool",
          { state: "started", partId: "same", toolUseId: "same-call", name: "read", input: {} },
          scope,
        ),
        event(
          index * 3 + 2,
          "tool",
          {
            state: "completed",
            partId: "same",
            toolUseId: "same-call",
            name: "read",
            input: { index },
            content: `Result ${index}`,
            isError: index === 1,
          },
          scope,
        ),
      );
    });
    const entries = parseTranscript(jsonl(records));
    expect(entries.filter((entry) => entry.blockType === "text")).toHaveLength(4);
    expect(entries.filter((entry) => entry.blockType === "tool_use")).toHaveLength(4);
    expect(
      entries
        .filter((entry) => entry.blockType === "tool_result")
        .map((entry) => [entry.content, entry.label]),
    ).toEqual([
      ["Result 0", ""],
      ["Result 1", "Error"],
      ["Result 2", ""],
      ["Result 3", ""],
    ]);
  });

  it("merges tools through either identity, uses latest completion, ignores stale starts", () => {
    const entries = parseTranscript(
      jsonl([
        event(1, "tool", { state: "started", toolUseId: "call", name: "read", input: {} }),
        event(2, "tool", {
          state: "completed",
          partId: "part",
          toolUseId: "call",
          name: "read",
          input: { path: "first" },
          content: "first output",
        }),
        event(3, "tool", {
          state: "completed",
          partId: "part",
          input: { path: "latest" },
          content: "latest output",
        }),
        event(4, "tool", { state: "started", partId: "part", name: "read", input: {} }),
      ]),
    );
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ label: "read", content: '{\n  "path": "latest"\n}' });
    expect(entries[1].content).toBe("latest output");
  });

  it("renders standalone completed tools and tool failures", () => {
    expect(
      parseTranscript(
        jsonl([
          event(1, "tool", {
            state: "completed",
            partId: "tool",
            toolName: "check",
            isError: true,
            content: "Command failed",
          }),
        ]),
      ).map((entry) => [entry.blockType, entry.label, entry.content]),
    ).toEqual([
      ["tool_use", "check", ""],
      ["tool_result", "Error", "Command failed"],
    ]);
  });

  it("renders error diagnostics and terminal fallback even without text events", () => {
    expect(
      parseTranscript(
        jsonl([
          event(1, "error", { message: "Provider unavailable" }),
          event(2, "terminal", {
            state: "failed",
            resultText: "Partial work saved",
            reason: "Retry budget exceeded",
          }),
        ]),
      ).map((entry) => entry.content),
    ).toEqual(["Provider unavailable", "Partial work saved", "Retry budget exceeded"]);
    expect(parseTranscript(jsonl([event(1, "terminal", { state: "timed_out" })]))[0].content).toBe(
      "Run timed_out",
    );
    expect(
      parseTranscript(
        jsonl([event(1, "terminal", { state: "failed", failure: { message: "Failure details" } })]),
      )[0].content,
    ).toContain("Failure details");
  });

  it("deduplicates identical terminal diagnostics without merging different scopes, states or reasons", () => {
    const failure = {
      state: "failed",
      reason: "Retry budget exceeded",
      resultText: "Partial work saved",
    };
    const entries = parseTranscript(
      jsonl([
        event(1, "terminal", failure),
        event(2, "terminal", failure),
        event(3, "terminal", { state: "failed", reason: "Provider unavailable" }),
        event(
          4,
          "terminal",
          { state: "failed", reason: failure.reason },
          { runtimeSessionRef: "child" },
        ),
        event(5, "terminal", { state: "failed", reason: failure.reason }, { runId: "another-run" }),
        event(
          6,
          "terminal",
          { state: "failed", reason: failure.reason },
          { attemptId: "another-attempt" },
        ),
        event(7, "terminal", { state: "timed_out", reason: failure.reason }),
        event(8, "terminal", { state: "failed" }),
        event(9, "terminal", { state: "failed" }),
      ]),
    );
    expect(
      entries.filter((entry) => entry.blockType === "text").map((entry) => entry.content),
    ).toEqual(["Partial work saved"]);
    expect(
      entries
        .filter((entry) => entry.blockType === "error")
        .map((entry) => [entry.label, entry.content]),
    ).toEqual([
      ["failed", "Retry budget exceeded"],
      ["failed", "Provider unavailable"],
      ["failed", "Retry budget exceeded"],
      ["failed", "Retry budget exceeded"],
      ["failed", "Retry budget exceeded"],
      ["timed_out", "Retry budget exceeded"],
      ["failed", "Run failed"],
    ]);
  });

  it("omits terminal prose duplicated by root parts, without matching child or other run", () => {
    const records = [
      event(1, "model", { phase: "text", partId: "one", text: "Hello " }),
      event(2, "model", { phase: "text", partId: "two", text: "world" }),
      event(3, "terminal", { state: "completed", resultText: "Hello world" }),
      event(
        4,
        "terminal",
        { state: "completed", resultText: "Hello world" },
        { runtimeSessionRef: undefined },
      ),
    ];
    expect(parseTranscript(jsonl(records)).map((entry) => entry.content)).toEqual([
      "Hello ",
      "world",
    ]);
    expect(
      parseTranscript(
        jsonl([
          event(
            1,
            "model",
            { phase: "text", partId: "one", text: "Same text" },
            { runtimeSessionRef: "child" },
          ),
          event(2, "terminal", { state: "completed", resultText: "Same text" }),
          event(
            3,
            "terminal",
            { state: "completed", resultText: "Same text" },
            { runId: "another-run" },
          ),
        ]),
      ),
    ).toHaveLength(3);
  });

  it("preserves Claude text, thinking, tool use/results and string content", () => {
    const entries = parseTranscript(
      jsonl([
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "Legacy answer" },
              { type: "thinking", thinking: "Legacy reasoning" },
              { type: "tool_use", name: "Read", input: { file_path: "example.ts" } },
            ],
          },
        },
        {
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                content: ["first", { type: "text", text: "second" }, null],
                is_error: true,
              },
            ],
          },
        },
        { type: "user", message: { role: "user", content: "Follow-up question" } },
      ]),
    );
    expect(entries.map((entry) => entry.content)).toEqual([
      "Legacy answer",
      "Legacy reasoning",
      "file_path=example.ts",
      "first\nsecond\n",
      "Follow-up question",
    ]);
    expect(entries[3].label).toBe("Error");
    expect(entries[4].role).toBe("user");
  });

  it("defensively skips malformed JSON, primitives, blocks, unknown schemas and noise", () => {
    const raw = `not json\n${jsonl([
      null,
      [],
      1,
      true,
      "text",
      {},
      { message: null },
      { message: [] },
      {
        type: "assistant",
        message: {
          role: {},
          content: [
            null,
            [],
            "block",
            { type: "text", text: 1 },
            { type: "thinking", thinking: {} },
            { type: "unknown" },
          ],
        },
      },
      { type: "attachment", message: { content: "ignored" } },
      event(1, "model", { phase: "text", text: "Unknown version" }, { schemaVersion: "2" }),
      event(2, "model", {}, { payload: null }),
      event(3, "usage", { tokens: 1 }),
      event(4, "run", { state: "started" }),
      event(5, "model", { phase: "updated" }),
      event(6, "tool", { state: "unknown" }),
    ])}`;
    expect(parseTranscript(raw)).toEqual([]);
    expect(parseTranscript("")).toEqual([]);
  });

  it("survives malformed tool results and mixed formats while preserving valid neighbors", () => {
    const entries = parseTranscript(
      jsonl([
        {
          type: "user",
          message: {
            content: [{ type: "tool_result", content: [null, 3, { text: 4 }, ["nested"]] }],
          },
        },
        event(1, "model", {
          phase: "text",
          partId: "answer",
          text: { invalid: true },
          delta: "Valid delta",
        }),
        { type: "assistant", message: { content: "Valid legacy" } },
      ]),
    );
    expect(entries).toHaveLength(3);
    expect(entries[0].content).toContain('"text": 4');
    expect(entries[1].content).toBe("Valid delta");
    expect(entries[2].content).toBe("Valid legacy");
  });

  it("does not invoke object coercion on malformed legacy tool inputs", () => {
    const entries = parseTranscript(
      jsonl([
        {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                name: "inspect",
                input: { value: { toString: null, valueOf: null } },
              },
            ],
          },
        },
      ]),
    );
    expect(entries[0].content).toContain('"toString": null');
  });
});
