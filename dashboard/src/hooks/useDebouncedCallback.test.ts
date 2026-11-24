import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDebouncedCallback } from "./useDebouncedCallback";

describe("useDebouncedCallback", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces rapid calls into one trailing invocation with the latest arguments", async () => {
    const callback = vi.fn();
    const { result } = renderHook(() => useDebouncedCallback(callback, 1000));

    act(() => {
      result.current("first");
      result.current("second");
      result.current("third");
    });
    expect(callback).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith("third");
  });

  it("restarts the trailing delay on every call", async () => {
    const callback = vi.fn();
    const { result } = renderHook(() => useDebouncedCallback(callback, 1000));

    act(() => {
      result.current("first");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    act(() => {
      result.current("second");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(callback).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith("second");
  });

  it("cancels the pending invocation on unmount", async () => {
    const callback = vi.fn();
    const { result, unmount } = renderHook(() => useDebouncedCallback(callback, 1000));

    act(() => {
      result.current("first");
    });
    unmount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(callback).not.toHaveBeenCalled();
  });

  it("invokes the latest callback after a re-render swaps it", async () => {
    const first = vi.fn();
    const second = vi.fn();
    const { result, rerender } = renderHook(
      ({ callback }) => useDebouncedCallback(callback, 1000),
      {
        initialProps: { callback: first },
      },
    );

    act(() => {
      result.current("payload");
    });
    rerender({ callback: second });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith("payload");
  });
});
