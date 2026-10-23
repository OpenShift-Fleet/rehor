import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import GlobalSearch from "./GlobalSearch";

function Location() {
  const location = useLocation(),
    navigate = useNavigate();
  return (
    <>
      <output aria-label="Current URL">
        {location.pathname}
        {location.search}
      </output>
      <button type="button" onClick={() => navigate(-1)}>
        Back
      </button>
      <button type="button" onClick={() => navigate(1)}>
        Forward
      </button>
      <button type="button" onClick={() => navigate("/instances", { replace: true })}>
        Initial redirect
      </button>
      <button type="button" onClick={() => navigate("/archived")}>
        Archive view
      </button>
    </>
  );
}
function mount(path = "/tasks") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <GlobalSearch />
      <Location />
    </MemoryRouter>,
  );
}
async function tick() {
  await act(async () => {
    vi.advanceTimersByTime(200);
  });
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Task-list header search", () => {
  it.each(["/cycles", "/instances/review-bot/cycles"])(
    "waits for two characters before leaving %s",
    async (path) => {
      mount(path);
      const input = screen.getByRole("searchbox");
      fireEvent.change(input, { target: { value: "r" } });
      await tick();
      expect(screen.getByLabelText("Current URL")).toHaveTextContent(new RegExp(`^${path}$`));
      fireEvent.keyDown(input, { key: "Enter" });
      expect(screen.getByLabelText("Current URL")).toHaveTextContent(new RegExp(`^${path}$`));
      fireEvent.click(screen.getByRole("button", { name: "Clear global search" }));
      expect(screen.getByLabelText("Current URL")).toHaveTextContent(new RegExp(`^${path}$`));
      fireEvent.change(input, { target: { value: "re" } });
      await tick();
      expect(screen.getByLabelText("Current URL")).toHaveTextContent(
        `${path.replace(/cycles$/, "tasks")}?q=re`,
      );
    },
  );
  it("keeps a fresh draft when a list navigation settles in the same render", async () => {
    mount("/tasks");
    const input = screen.getByRole("searchbox");
    act(() => {
      fireEvent.change(input, { target: { value: "review" } });
      fireEvent.click(screen.getByRole("button", { name: "Archive view" }));
    });
    await tick();
    expect(input).toHaveValue("review");
    expect(screen.getByLabelText("Current URL")).toHaveTextContent("/archived?q=review");
  });
  it.each(["", "/instances/review-bot"])(
    "Archive keeps view and instance on edit, history and clear (%s)",
    async (prefix) => {
      mount(`${prefix}/archived?q=first&page=3&task_id=42`);
      const input = screen.getByRole("searchbox", {
        name: prefix ? "Search archived tasks in this instance" : "Search archived tasks",
      });
      expect(input).toHaveValue("first");
      fireEvent.change(input, { target: { value: "second" } });
      await tick();
      expect(screen.getByLabelText("Current URL")).toHaveTextContent(`${prefix}/archived?q=second`);
      fireEvent.click(screen.getByRole("button", { name: "Back" }));
      await tick();
      expect(input).toHaveValue("first");
      fireEvent.click(screen.getByRole("button", { name: "Forward" }));
      await tick();
      expect(input).toHaveValue("second");
      fireEvent.click(screen.getByRole("button", { name: "Clear global search" }));
      expect(screen.getByLabelText("Current URL")).toHaveTextContent(
        new RegExp(`^${prefix}/archived$`),
      );
      expect(input).toHaveFocus();
    },
  );
  it("preserves a draft typed before the initial root redirect finishes", async () => {
    mount("/");
    const input = screen.getByRole("searchbox");
    fireEvent.change(input, { target: { value: "review" } });
    fireEvent.click(screen.getByRole("button", { name: "Initial redirect" }));
    await tick();
    expect(input).toHaveValue("review");
    expect(screen.getByLabelText("Current URL")).toHaveTextContent("/tasks?q=review");
  });
  it("debounces navigation into task results instead of rendering a dropdown", async () => {
    mount();
    const input = screen.getByRole("searchbox", { name: "Search all instances" });
    fireEvent.change(input, { target: { value: "review" } });
    expect(screen.getByLabelText("Current URL")).toHaveTextContent(/^\/tasks$/);
    await tick();
    expect(screen.getByLabelText("Current URL")).toHaveTextContent("/tasks?q=review");
    expect(screen.queryByRole("region", { name: "Global search results" })).not.toBeInTheDocument();
  });
  it("keeps status while resetting pagination and exact task focus on a new query", async () => {
    mount("/tasks?status=done&page=3&task_id=42");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "review" } });
    await tick();
    expect(screen.getByLabelText("Current URL")).toHaveTextContent("/tasks?status=done&q=review");
  });
  it("uses one integrated clear action and returns focus without losing status", () => {
    mount("/tasks?q=review&status=done&page=2");
    const input = screen.getByRole("searchbox");
    fireEvent.click(screen.getByRole("button", { name: "Clear global search" }));
    expect(input).toHaveValue("");
    expect(input).toHaveFocus();
    expect(screen.getByLabelText("Current URL")).toHaveTextContent("/tasks?status=done");
    expect(screen.queryByRole("button", { name: "Clear global search" })).not.toBeInTheDocument();
  });
  it("Enter opens task search immediately from another view, dropping cycle-only parameters", () => {
    mount("/cycles?task_id=42&cycle=91");
    const input = screen.getByRole("searchbox");
    fireEvent.change(input, { target: { value: " review " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByLabelText("Current URL")).toHaveTextContent("/tasks?q=review");
  });
  it("respects selected instance and status scope", async () => {
    mount("/instances/review-bot/tasks?status=done");
    fireEvent.change(screen.getByRole("searchbox", { name: "Search tasks in this instance" }), {
      target: { value: "review" },
    });
    await tick();
    expect(screen.getByLabelText("Current URL")).toHaveTextContent(
      "/instances/review-bot/tasks?status=done&q=review",
    );
  });
  it("back and forward restore the query without stale draft navigation", async () => {
    mount("/tasks?q=first&status=done");
    const input = screen.getByRole("searchbox");
    fireEvent.change(input, { target: { value: "second" } });
    await tick();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await tick();
    expect(input).toHaveValue("first");
    expect(screen.getByLabelText("Current URL")).toHaveTextContent("/tasks?q=first&status=done");
    fireEvent.click(screen.getByRole("button", { name: "Forward" }));
    await tick();
    expect(input).toHaveValue("second");
    expect(screen.getByLabelText("Current URL")).toHaveTextContent("/tasks?q=second&status=done");
  });
});
