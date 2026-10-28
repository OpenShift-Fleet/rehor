import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { coordinatorTranscript, jsonl, viewerAnswer } from "../test/transcript-fixtures";
import type { CycleRun, TaskCycleGroup } from "../types";
import CycleRuns from "./CycleRuns";

vi.mock("../api", () => ({
  fetchCycleRunsByTask: vi.fn(),
  fetchCycleRuns: vi.fn(),
  fetchCycleRunTranscript: vi.fn(),
}));

vi.mock("../hooks/useWebSocket", () => ({
  useWS: () => ({ connected: true, lastEvent: null, onEvent: () => () => {} }),
}));

import { fetchCycleRuns, fetchCycleRunsByTask, fetchCycleRunTranscript } from "../api";

const mockFetchCycleRunsByTask = vi.mocked(fetchCycleRunsByTask);
const mockFetchCycleRuns = vi.mocked(fetchCycleRuns);
const mockFetchTranscript = vi.mocked(fetchCycleRunTranscript);

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

let nextRunId = 1000;

async function openTranscript(transcript: string) {
  const id = nextRunId++;
  const run: CycleRun = {
    id,
    task_id: 42,
    cycle_type: "task_work",
    instance_id: "test-bot",
    started_at: "2026-01-01T00:00:00Z",
    finished_at: "2026-01-01T00:01:00Z",
    tool_calls: 1,
    tokens_used: 120,
    progress: {},
    input_prompt: null,
    created_at: "2026-01-01T00:00:00Z",
    has_transcript: true,
  };
  const group: TaskCycleGroup = {
    task_id: 42,
    external_key: "TEST-42",
    title: "Synthetic transcript",
    task_status: null,
    repo: null,
    cycle_count: 1,
    transcript_count: 1,
    total_tool_calls: 1,
    total_tokens: 120,
    first_cycle: run.started_at,
    last_cycle: run.finished_at,
  };
  mockFetchCycleRunsByTask.mockResolvedValue({ items: [group], total: 1, limit: 20, offset: 0 });
  mockFetchCycleRuns.mockResolvedValue({ items: [run], total: 1, limit: 20, offset: 0 });
  mockFetchTranscript.mockResolvedValue(transcript);
  render(
    <MemoryRouter initialEntries={[`/cycles?cycle=${id}&task_id=42`]}>
      <CycleRuns />
    </MemoryRouter>,
  );
  await userEvent.click(await screen.findByRole("button", { name: "Load Transcript" }));
  await screen.findByPlaceholderText("Search transcript...");
  expect(mockFetchTranscript).toHaveBeenCalledWith(id);
  return id;
}

describe("CycleRuns page", () => {
  it("handles empty cycle runs response correctly", async () => {
    // Mock API returns paginated response with items array
    mockFetchCycleRunsByTask.mockResolvedValue({
      items: [],
      total: 0,
      limit: 20,
      offset: 0,
    });

    render(
      <MemoryRouter initialEntries={["/instances/dev-bot/cycles"]}>
        <Routes>
          <Route path="/instances/:instanceId/cycles" element={<CycleRuns />} />
        </Routes>
      </MemoryRouter>,
    );

    // Should render empty state without crashing
    await waitFor(() => {
      expect(screen.getByText("No cycle runs found")).toBeInTheDocument();
    });
  });

  it("handles cycle runs with task groups", async () => {
    const mockGroups = [
      {
        task_id: 1,
        external_key: "RHCLOUD-001",
        summary: "Fix login bug",
        cycle_count: 3,
        last_cycle_start: "2026-07-24T10:00:00Z",
      },
      {
        task_id: 2,
        external_key: "RHCLOUD-002",
        summary: "Add dark mode",
        cycle_count: 1,
        last_cycle_start: "2026-07-24T09:00:00Z",
      },
    ];

    mockFetchCycleRunsByTask.mockResolvedValue({
      items: mockGroups,
      total: 2,
      limit: 20,
      offset: 0,
    });

    mockFetchCycleRuns.mockResolvedValue({
      items: [],
      total: 0,
      limit: 20,
      offset: 0,
    });

    render(
      <MemoryRouter initialEntries={["/instances/dev-bot/cycles"]}>
        <Routes>
          <Route path="/instances/:instanceId/cycles" element={<CycleRuns />} />
        </Routes>
      </MemoryRouter>,
    );

    // Should render both task groups
    await waitFor(() => {
      expect(screen.getByText("RHCLOUD-001")).toBeInTheDocument();
      expect(screen.getByText("RHCLOUD-002")).toBeInTheDocument();
    });
  });
});

describe("CycleRuns transcript viewer", () => {
  it("loads normalized events, filters/searches, toggles Thinking and Raw", async () => {
    await openTranscript(coordinatorTranscript);
    expect(screen.getByText("3 entries")).toBeInTheDocument();
    expect(screen.getAllByText("inspect")).toHaveLength(1);
    expect(screen.getByText(/example.ts/)).toBeInTheDocument();
    expect(screen.getByText("Synthetic inspection passed")).toBeInTheDocument();
    expect(screen.queryByText("Check synthetic inputs first.")).not.toBeInTheDocument();
    expect(screen.queryByText(/Completed synthetic review/)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Thinking" }));
    expect(screen.getByText("4 entries")).toBeInTheDocument();
    expect(screen.getByText("Check synthetic inputs first.")).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("Search transcript..."), {
      target: { value: "completed synthetic" },
    });
    expect(screen.getByText("1 entries")).toBeInTheDocument();
    expect(screen.getByText("Completed synthetic", { selector: "mark" })).toBeInTheDocument();
    expect(screen.queryByText("inspect")).not.toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("Search transcript..."), {
      target: { value: "no-such-entry" },
    });
    expect(
      screen.getByText("No entries match the current search and Thinking filters."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/No renderable messages/)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Raw" }));
    const raw = document.querySelector(".transcript-raw");
    expect(raw?.textContent).toBe(coordinatorTranscript);
  });

  it("keeps collapse state attached to original entries across Thinking and search filters", async () => {
    await openTranscript(coordinatorTranscript);
    // A short hidden reasoning block precedes a large assistant block.
    expect(screen.queryByText(viewerAnswer.trim())).not.toBeInTheDocument();
    await userEvent.click(screen.getByText("assistant"));
    expect(screen.getByText(viewerAnswer.trim())).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Thinking" }));
    expect(screen.getByText(viewerAnswer.trim())).toBeInTheDocument();
    await userEvent.click(screen.getByText("assistant"));
    expect(screen.queryByText(viewerAnswer.trim())).not.toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("Search transcript..."), {
      target: { value: "Completed" },
    });
    expect(document.querySelector(".transcript-line-content")?.textContent).toBe(viewerAnswer);
    fireEvent.change(screen.getByPlaceholderText("Search transcript..."), {
      target: { value: "" },
    });
    await userEvent.click(screen.getByRole("button", { name: "Thinking" }));
    expect(screen.queryByText(viewerAnswer.trim())).not.toBeInTheDocument();
    await userEvent.click(screen.getByText("assistant"));
    expect(screen.getByText(viewerAnswer.trim())).toBeInTheDocument();
  });

  it("renders legacy Claude messages through the same viewer", async () => {
    await openTranscript(
      jsonl([
        { type: "user", message: { content: "Legacy question" } },
        {
          type: "assistant",
          message: {
            content: [
              { type: "thinking", thinking: "Legacy plan" },
              { type: "text", text: "Legacy answer" },
              { type: "tool_use", name: "Read", input: { path: "example.ts" } },
            ],
          },
        },
        { type: "user", message: { content: [{ type: "tool_result", content: "Legacy output" }] } },
      ]),
    );
    expect(screen.getByText("Legacy question")).toBeInTheDocument();
    expect(screen.getByText("Legacy answer")).toBeInTheDocument();
    expect(screen.getByText("Read")).toBeInTheDocument();
    expect(screen.getByText("Legacy output")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Thinking" }));
    expect(screen.getByText("Legacy plan")).toBeInTheDocument();
  });

  it.each([
    ["metadata", jsonl([{ schemaVersion: "1", kind: "usage", payload: {} }])],
    [
      "unsupported schema",
      jsonl([{ schemaVersion: "2", kind: "model", payload: { text: "future" } }]),
    ],
    ["malformed records", "null\n[]\nnot-json"],
    ["empty transcript", ""],
  ])(
    "shows informative no-message state for %s, with Raw still available",
    async (_label, transcript) => {
      await openTranscript(transcript);
      expect(screen.getByText(/No renderable messages in this transcript/)).toBeInTheDocument();
      expect(screen.queryByText(/No entries match/)).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: "Raw" }));
      expect(document.querySelector(".transcript-raw")?.textContent).toBe(transcript);
    },
  );

  it("downloads original transcript rather than rendered/deduplicated text", async () => {
    const createObjectURL = vi.fn((_blob: Blob) => "blob:synthetic-transcript");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal(
      "URL",
      class extends URL {
        static createObjectURL = createObjectURL;
        static revokeObjectURL = revokeObjectURL;
      },
    );
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const id = await openTranscript(coordinatorTranscript);
    const viewer = document.querySelector(".transcript-viewer") as HTMLElement;
    await userEvent.click(within(viewer).getByTitle("Download transcript"));
    expect(click).toHaveBeenCalledOnce();
    const anchor = click.mock.instances[0] as HTMLAnchorElement;
    expect(anchor.download).toBe(`cycle-${id}.jsonl`);
    expect(anchor.href).toBe("blob:synthetic-transcript");
    const blob = createObjectURL.mock.calls[0][0];
    expect(blob.type).toBe("application/x-ndjson");
    expect(blob.size).toBe(new TextEncoder().encode(coordinatorTranscript).length);
    const downloaded = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(blob);
    });
    expect(downloaded).toBe(coordinatorTranscript);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:synthetic-transcript");
  });
});
