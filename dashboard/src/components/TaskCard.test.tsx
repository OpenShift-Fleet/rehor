import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it } from "vitest";
import { makeTask } from "../test/helpers";
import TaskCard from "./TaskCard";

afterEach(cleanup);
it.each([
  { query: "mo", title: "DEMO-200 · Search demo item 200", repo: "org/repo", marks: ["MO", "mo"] },
  {
    query: " [review] ",
    title: "Literal <img> [Review] and [REVIEW]",
    repo: "org/[review]",
    marks: ["[Review]", "[REVIEW]", "[review]"],
  },
  { query: ".*", title: "Literal .* pattern", repo: "org/.*", marks: [".*", ".*"] },
])(
  "highlights every literal $query occurrence in task results without HTML injection",
  ({ query, title, repo, marks }) => {
    const { container } = render(
      <MemoryRouter>
        <TaskCard
          task={makeTask({
            title,
            repo,
            external_key: "TASK-1",
            instance_id: "dev-bot",
            metadata: {},
            slack_notification: undefined,
            paused_reason: null,
          })}
          query={query}
        />
      </MemoryRouter>,
    );
    expect([...container.querySelectorAll("mark")].map((mark) => mark.textContent)).toEqual(marks);
    expect(container).toHaveTextContent(title);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByRole("button", { name: "TASK-1" })).toBeInTheDocument();
  },
);
