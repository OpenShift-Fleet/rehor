import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ErrorBoundary from "./ErrorBoundary";

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ErrorBoundary", () => {
  it("renders children when there is no error", () => {
    render(
      <ErrorBoundary>
        <div>healthy content</div>
      </ErrorBoundary>,
    );

    expect(screen.getByText("healthy content")).toBeInTheDocument();
  });

  it("renders a fallback instead of crashing the page", () => {
    function Broken(): ReactNode {
      throw new Error("files_changed.map is not a function");
    }

    render(
      <ErrorBoundary>
        <Broken />
      </ErrorBoundary>,
    );

    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    expect(screen.getByText("files_changed.map is not a function")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload page" })).toBeInTheDocument();
    expect(console.error).toHaveBeenCalled();
  });

  it("uses a custom title when provided", () => {
    function Broken(): ReactNode {
      throw new Error("boom");
    }

    render(
      <ErrorBoundary title="Cycle runs failed to render">
        <Broken />
      </ErrorBoundary>,
    );

    expect(screen.getByText("Cycle runs failed to render")).toBeInTheDocument();
  });

  it("retries rendering after the error condition is fixed", () => {
    let broken = true;

    function Flaky() {
      if (broken) throw new Error("boom");
      return <div>recovered</div>;
    }

    render(
      <ErrorBoundary>
        <Flaky />
      </ErrorBoundary>,
    );
    expect(screen.getByText("boom")).toBeInTheDocument();

    broken = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(screen.getByText("recovered")).toBeInTheDocument();
  });
});
