import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import type { BotInstance, WSEvent } from "./types";

const wsHarness = vi.hoisted(() => {
  const listeners = new Set<(event: WSEvent) => void>();
  return {
    register(callback: (event: WSEvent) => void): () => void {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },
    emit(event: WSEvent): void {
      for (const listener of listeners) listener(event);
    },
    reset(): void {
      listeners.clear();
    },
  };
});

vi.mock("./hooks/useWebSocket", () => ({
  useWS: () => ({ connected: true, onEvent: wsHarness.register }),
  WSProvider: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("./api", () => ({
  fetchInstances: vi.fn(),
  fetchStats: vi.fn(),
}));

import { fetchInstances, fetchStats } from "./api";

const mockFetchInstances = vi.mocked(fetchInstances);
const mockFetchStats = vi.mocked(fetchStats);

const baseInstance: BotInstance = {
  instance_id: "bot-alpha",
  state: "idle",
  message: "nothing to do",
  external_key: null,
  source_type: null,
  source_url: null,
  repo: null,
  cycle_start: null,
  updated_at: "2026-11-13T10:00:00Z",
  active_tasks: 1,
  max_tasks: 10,
};

/** Renders the app on the overview route and waits for both initial loads. */
async function renderApp() {
  render(<App />);
  expect(await screen.findByText("bot-alpha")).toBeInTheDocument();
  // One fetch from the App shell and one from the Instances page.
  await waitFor(() => {
    expect(mockFetchInstances).toHaveBeenCalledTimes(2);
  });
  await waitFor(() => {
    expect(mockFetchStats).toHaveBeenCalledTimes(1);
  });
}

describe("App WebSocket event handling", () => {
  beforeEach(() => {
    // Node's experimental localStorage global is undefined under jsdom; the
    // ThemeSelector rendered by the app shell needs a working one.
    vi.stubGlobal("localStorage", {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn(),
    });
    vi.clearAllMocks();
    wsHarness.reset();
    mockFetchInstances.mockResolvedValue([baseInstance]);
    mockFetchStats.mockResolvedValue({ tasks: {}, memories: { total: 3 } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("merges bot_status events locally without refetching /api/instances", async () => {
    await renderApp();

    await act(async () => {
      wsHarness.emit({
        type: "bot_status",
        data: { instance_id: "bot-alpha", state: "working", message: "churning on REHOR-9001" },
        timestamp: 1,
      });
      wsHarness.emit({
        type: "bot_status",
        data: { instance_id: "bot-beta", state: "working", message: "just registered" },
        timestamp: 2,
      });
    });

    // No refetch for either an update to a known instance or a new instance.
    expect(mockFetchInstances).toHaveBeenCalledTimes(2);

    // The App-level merge is visible through the instance selector: the known
    // instance is updated and the unknown one is appended.
    await userEvent.click(screen.getByRole("button", { name: /all instances/i }));
    expect(screen.getByText("bot-alpha — WORKING")).toBeInTheDocument();
    expect(screen.getByText("bot-beta — WORKING")).toBeInTheDocument();
  });

  it("coalesces bursts of task events into a single debounced refetch", async () => {
    await renderApp();

    vi.useFakeTimers();
    await act(async () => {
      for (let i = 0; i < 5; i++) {
        wsHarness.emit({ type: "task_added", data: { id: i }, timestamp: i });
      }
      wsHarness.emit({ type: "memory_stored", data: { id: 9 }, timestamp: 6 });
    });

    // Nothing refetches while the burst is ongoing.
    expect(mockFetchInstances).toHaveBeenCalledTimes(2);
    expect(mockFetchStats).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    // One coalesced refetch per subscriber: the App shell (stats + instances)
    // and the Instances page (instances).
    expect(mockFetchInstances).toHaveBeenCalledTimes(4);
    expect(mockFetchStats).toHaveBeenCalledTimes(2);

    // No further refetches once the burst has been coalesced.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(mockFetchInstances).toHaveBeenCalledTimes(4);
    expect(mockFetchStats).toHaveBeenCalledTimes(2);
  });
});
