import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCompatibilitySink, DEFAULT_STATUS_THROTTLE_MS } from "../src/adapters/compatibility";
import type { StatusUpdate } from "../src/ports/compatibility";

function working(message: string, instanceId = "instance-1"): StatusUpdate {
  return { state: "working", message, instanceId };
}

async function localStatusMessages(dataDirectory: string): Promise<string[]> {
  const raw = await readFile(join(dataDirectory, "status.jsonl"), "utf8");
  return raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => (JSON.parse(line) as { message: string }).message);
}

function postedPayload(fetch: ReturnType<typeof makeFetch>, index: number) {
  return JSON.parse(String(fetch.mock.calls[index]?.[1]?.body));
}

function makeFetch() {
  return vi.fn<typeof globalThis.fetch>(async () => new Response("{}", { status: 201 }));
}

async function makeSink(statusThrottleMs = 2000) {
  const dataDirectory = await mkdtemp(join(tmpdir(), "rehor-status-throttle-"));
  const fetch = makeFetch();
  const sink = createCompatibilitySink({
    dataDirectory,
    statusUrl: "http://memory-server/api/bot-status",
    fetch,
    statusThrottleMs,
  });
  return { dataDirectory, fetch, sink };
}

describe("status POST throttling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("exports a two second default throttle interval", () => {
    expect(DEFAULT_STATUS_THROTTLE_MS).toBe(2000);
  });

  it("coalesces a working burst into one immediate and one trailing POST with the latest payload", async () => {
    const { dataDirectory, fetch, sink } = await makeSink();

    for (let i = 1; i <= 5; i++) {
      await sink.writers.status?.write(working(`tool-${i}`));
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(postedPayload(fetch, 0)).toMatchObject({
      state: "working",
      message: "tool-1",
      instance_id: "instance-1",
    });

    // The trailing timer fires when the interval since the immediate POST elapses.
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(postedPayload(fetch, 1)).toMatchObject({
      state: "working",
      message: "tool-5",
      instance_id: "instance-1",
    });

    // The window resets after the trailing POST: the next working update defers again.
    await sink.writers.status?.write(working("tool-6"));
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(postedPayload(fetch, 2)).toMatchObject({ state: "working", message: "tool-6" });

    // No further POSTs once the burst has been flushed.
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetch).toHaveBeenCalledTimes(3);

    expect(await localStatusMessages(dataDirectory)).toEqual([
      "tool-1",
      "tool-2",
      "tool-3",
      "tool-4",
      "tool-5",
      "tool-6",
    ]);
  });

  it("cancels the pending working POST when a non-working update arrives", async () => {
    const { dataDirectory, fetch, sink } = await makeSink();

    await sink.writers.status?.write(working("tool-1"));
    await vi.advanceTimersByTimeAsync(100);
    await sink.writers.status?.write(working("tool-2"));
    await sink.writers.status?.write({
      state: "idle",
      message: "cycle complete",
      instanceId: "instance-1",
    });

    // Immediate POST for the working start, immediate POST for the idle update,
    // and the pending working POST is dropped instead of flushed.
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(postedPayload(fetch, 1)).toMatchObject({
      state: "idle",
      message: "cycle complete",
      instance_id: "instance-1",
    });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(await localStatusMessages(dataDirectory)).toEqual([
      "tool-1",
      "tool-2",
      "cycle complete",
    ]);
  });

  it("records every update in the local status.jsonl even while remote POSTs are throttled", async () => {
    const { dataDirectory, fetch, sink } = await makeSink();

    for (let i = 1; i <= 4; i++) {
      await sink.writers.status?.write(working(`tool-${i}`));
      await vi.advanceTimersByTimeAsync(50);
    }
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await localStatusMessages(dataDirectory)).toEqual([
      "tool-1",
      "tool-2",
      "tool-3",
      "tool-4",
    ]);
  });

  it("throttles distinct instanceIds independently", async () => {
    const { fetch, sink } = await makeSink();

    await sink.writers.status?.write(working("a-1", "instance-a"));
    await vi.advanceTimersByTimeAsync(100);
    await sink.writers.status?.write(working("b-1", "instance-b"));
    await sink.writers.status?.write(working("a-2", "instance-a"));
    await sink.writers.status?.write(working("b-2", "instance-b"));
    // First working POST per instance goes out immediately.
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(postedPayload(fetch, 0)).toMatchObject({ instance_id: "instance-a", message: "a-1" });
    expect(postedPayload(fetch, 1)).toMatchObject({ instance_id: "instance-b", message: "b-1" });

    await vi.advanceTimersByTimeAsync(2000);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(postedPayload(fetch, 2)).toMatchObject({ instance_id: "instance-a", message: "a-2" });
    expect(postedPayload(fetch, 3)).toMatchObject({ instance_id: "instance-b", message: "b-2" });
  });
});
