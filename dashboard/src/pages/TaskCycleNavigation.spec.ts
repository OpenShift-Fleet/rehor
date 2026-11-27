import { expect, test } from "../../e2e/fixtures";
import fixtures from "../test/fixtures.json" with { type: "json" };
import type { CycleRun, Task } from "../types";

const baseTask = fixtures.tasks["RHCLOUD-001"] as Task;
const run = (id: number, taskId: number | null): CycleRun => ({
  id,
  task_id: taskId,
  cycle_type: taskId === null ? "idle" : "task_work",
  instance_id: "demo-alpha",
  started_at: "2026-10-22T10:00:00Z",
  finished_at: "2026-10-22T10:01:00Z",
  created_at: "2026-10-22T10:00:00Z",
  tool_calls: 1,
  tokens_used: 100,
  input_prompt: null,
  has_transcript: false,
  progress: { last_step: `Sample step ${id}` },
});
let tasks: Task[];
let runs: CycleRun[];

test.beforeEach(async ({ page }) => {
  tasks = [
    {
      ...baseTask,
      id: 42,
      external_key: "HISTORY-42",
      title: "History active task",
      status: "in_progress",
    },
    {
      ...baseTask,
      id: 43,
      external_key: "HISTORY-43",
      title: "History archived task",
      status: "archived",
    },
    {
      ...baseTask,
      id: 44,
      external_key: "HISTORY-44",
      title: "History empty task",
      status: "in_progress",
    },
  ];
  runs = [run(91, 42), run(92, 43), run(93, null)];
  await page.route("**/api/**", (route) => {
    const url = new URL(route.request().url());
    const p = url.searchParams;
    let json: unknown = { items: [], total: 0 };
    if (url.pathname === "/api/stats") json = { tasks: {}, memories: { total: 0 } };
    if (url.pathname === "/api/instances") json = [];
    if (url.pathname === "/api/tasks") {
      const items = tasks.filter(
        (t) =>
          (!p.has("task_id") || String(t.id) === p.get("task_id")) &&
          (!p.has("status") || t.status === p.get("status")) &&
          (!p.has("exclude_status") || t.status !== p.get("exclude_status")),
      );
      json = { items, total: items.length };
    }
    if (url.pathname === "/api/cycle-runs/by-task") {
      const items = [42, 43, null].map((id) => {
        const task = tasks.find((t) => t.id === id);
        return {
          task_id: id,
          external_key: task?.external_key || null,
          title: task?.title || null,
          task_status: task?.status || null,
          cycle_count: runs.filter((r) => r.task_id === id).length,
          transcript_count: 0,
        };
      });
      json = { items, total: items.length };
    }
    if (url.pathname === "/api/cycle-runs") {
      const matching = runs.filter(
        (r) =>
          (!p.has("task_id") ||
            (p.get("task_id") === "none"
              ? r.task_id === null
              : String(r.task_id) === p.get("task_id") ||
                (r.task_id === null &&
                  tasks.some(
                    (t) =>
                      String(t.id) === p.get("task_id") &&
                      t.source_type === "jira" &&
                      t.external_key === r.progress.external_key,
                  )))) &&
          (!p.has("external_key") || (r.progress.external_key || "") === p.get("external_key")) &&
          (!p.has("run_id") || String(r.id) === p.get("run_id")),
      );
      const offset = Number(p.get("offset") || 0),
        limit = Number(p.get("limit") || 50);
      json = { items: matching.slice(offset, offset + limit), total: matching.length };
    }
    return route.fulfill({ json });
  });
});

test("search opens task history, exact cycle, then the same task", async ({ mount, page }) => {
  await mount("App/GlobalSearch");
  await page.getByRole("searchbox", { name: "Search all instances" }).fill("history");
  await page.getByRole("button", { name: "HISTORY-42", exact: true }).click();
  await page
    .getByRole("region", { name: "Cycle history" })
    .getByRole("link", { name: "Open cycle #91", exact: true })
    .click();
  const detail = page.getByRole("region", { name: "Cycle #91 details" });
  await expect(detail).toContainText("Sample step 91");
  await expect(detail.getByRole("link", { name: "Open task", exact: true })).toHaveAttribute(
    "href",
    "#/tasks?task_id=42",
  );
  await detail.getByRole("link", { name: "Open task", exact: true }).click();
  await expect(page).toHaveURL(/#\/tasks\?task_id=42$/);
  await expect(
    page
      .getByRole("region", { name: "Cycle history" })
      .getByRole("link", { name: "Open cycle #91", exact: true }),
  ).toBeVisible();
});

test("old exact cycles and changed hash targets work without reload, including browser back", async ({
  mount,
  page,
}) => {
  runs.unshift(...Array.from({ length: 60 }, (_, n) => run(100 + n, 42)));
  await mount("App/GlobalSearch");
  await page.evaluate(() => {
    window.location.hash = "/cycles?task_id=42&cycle=91";
  });
  await expect(page.getByRole("region", { name: "Cycle #91 details" })).toBeVisible();
  await page.evaluate(() => {
    window.location.hash = "/cycles?task_id=43&cycle=92";
  });
  const archived = page.getByRole("region", { name: "Cycle #92 details" });
  await expect(archived).toBeVisible();
  await expect(archived.getByRole("link", { name: "Open task", exact: true })).toHaveAttribute(
    "href",
    "#/archived?task_id=43",
  );
  await page.goBack();
  await expect(page.getByRole("region", { name: "Cycle #91 details" })).toBeVisible();
  await page.goForward();
  await expect(archived).toBeVisible();
  await archived.getByRole("link", { name: "Open task", exact: true }).click();
  await expect(page).toHaveURL(/#\/archived\?task_id=43$/);
  await page.reload();
  await page.waitForFunction("typeof window.mount === 'function'");
  await page.evaluate("window.mount('App/GlobalSearch')");
  await expect(
    page
      .getByRole("region", { name: "Cycle history" })
      .getByRole("link", { name: "Open cycle #92", exact: true }),
  ).toBeVisible();
});

test("global cycles retains unassociated runs without fabricated task links", async ({
  mount,
  page,
}) => {
  await mount("App/GlobalSearch");
  await page.getByRole("link", { name: "Cycles", exact: true }).click();
  await page.getByText("Orphan cycles", { exact: true }).click();
  await page.getByText("#93", { exact: true }).click();
  const detail = page.getByRole("region", { name: "Cycle #93 details" });
  await expect(detail).toContainText("No associated task");
  await expect(detail.getByRole("link", { name: "Open task", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Show all cycles", exact: true }).click();
  await expect(page.locator(".task-group-list > div")).toHaveCount(3);
});

for (const explicitScope of [true, false]) {
  test(`orphan cycle preserves history with a same-key task (${explicitScope ? "explicit" : "cycle-only"})`, async ({
    mount,
    page,
  }) => {
    tasks[1] = { ...tasks[1], source_type: "github", external_key: "COLLIDE-1" };
    runs = [
      { ...run(91, null), progress: { external_key: "COLLIDE-1", last_step: "Orphan step" } },
      run(92, 43),
      { ...run(93, null), progress: { external_key: "OTHER-1" } },
    ];
    await page.route("**/api/cycle-runs/by-task*", (route) =>
      route.fulfill({
        json: {
          items: [
            {
              ...fixtures.taskCycleGroups[0],
              task_id: 43,
              external_key: "COLLIDE-1",
              source_type: "github",
            },
            {
              ...fixtures.taskCycleGroups[0],
              task_id: null,
              external_key: "COLLIDE-1",
              source_type: null,
            },
          ],
          total: 2,
        },
      }),
    );
    await mount("App/GlobalSearch");
    await page.evaluate((explicit) => {
      window.location.hash = explicit
        ? "/cycles?task_id=none&external_key=COLLIDE-1"
        : "/cycles?cycle=91";
    }, explicitScope);
    const history = page.locator(".task-group-cycles");
    if (explicitScope) {
      await expect(history.getByText("#91", { exact: true })).toBeVisible();
      await history.getByText("#91", { exact: true }).click();
    }
    const detail = page.getByRole("region", { name: "Cycle #91 details" });
    await expect(detail).toBeVisible();
    await expect(history.getByText("#91", { exact: true })).toBeVisible();
    await expect(history.getByText("#92", { exact: true })).toHaveCount(0);
    await expect(history.getByText("#93", { exact: true })).toHaveCount(0);
    await expect(detail.getByRole("link", { name: "Open task", exact: true })).toHaveCount(0);
    await expect(page).toHaveURL(
      explicitScope ? /task_id=none&external_key=COLLIDE-1&cycle=91$/ : /cycles\?cycle=91$/,
    );
  });
}

test("cycle-only legacy link resolves Jira rather than another source with the same key", async ({
  mount,
  page,
}) => {
  tasks[0] = { ...tasks[0], source_type: "jira", external_key: "COLLIDE-1" };
  tasks[1] = { ...tasks[1], source_type: "github", external_key: "COLLIDE-1" };
  runs = [{ ...run(91, null), progress: { external_key: "COLLIDE-1" } }, run(92, 43), run(94, 42)];
  await page.route("**/api/cycle-runs/by-task*", (route) =>
    route.fulfill({
      json: {
        items: [
          {
            ...fixtures.taskCycleGroups[0],
            task_id: 43,
            external_key: "COLLIDE-1",
            source_type: "github",
          },
          {
            ...fixtures.taskCycleGroups[0],
            task_id: 42,
            external_key: "COLLIDE-1",
            source_type: "jira",
          },
        ],
        total: 2,
      },
    }),
  );
  await mount("App/GlobalSearch");
  await page.evaluate(() => {
    window.location.hash = "/cycles?cycle=91";
  });
  const detail = page.getByRole("region", { name: "Cycle #91 details" });
  await expect(detail.getByRole("link", { name: "Open task", exact: true })).toHaveAttribute(
    "href",
    "#/tasks?task_id=42",
  );
  const history = page.locator(".task-group-cycles");
  await expect(history.getByText("#91", { exact: true })).toBeVisible();
  await expect(history.getByText("#94", { exact: true })).toBeVisible();
  await expect(history.getByText("#92", { exact: true })).toHaveCount(0);
});

test("task history reports failure, then retries without pretending it is empty", async ({
  mount,
  page,
}) => {
  let failing = true;
  await page.route("**/api/cycle-runs?*", (route) =>
    failing ? route.fulfill({ status: 503, json: { error: "unavailable" } }) : route.fallback(),
  );
  await mount("App/GlobalSearch");
  await page.evaluate(() => {
    window.location.hash = "/tasks?task_id=42";
  });
  const history = page.getByRole("region", { name: "Cycle history" });
  await expect(history.getByRole("alert")).toContainText("Could not load cycle history.");
  await expect(history.getByText("No cycles recorded for this task.")).toHaveCount(0);
  failing = false;
  await history.getByRole("button", { name: "Retry cycle history", exact: true }).click();
  await expect(history.getByRole("link", { name: "Open cycle #91", exact: true })).toBeVisible();
});

test("task history paginates instead of silently hiding older runs", async ({ mount, page }) => {
  runs.unshift(...Array.from({ length: 6 }, (_, n) => run(100 + n, 42)));
  await mount("App/GlobalSearch");
  await page.evaluate(() => {
    window.location.hash = "/tasks?task_id=42";
  });
  const history = page.getByRole("region", { name: "Cycle history" });
  await expect(history.getByRole("link", { name: "Open cycle #100", exact: true })).toBeVisible();
  await expect(history.getByRole("link", { name: "Open cycle #91", exact: true })).toHaveCount(0);
  await history.getByRole("button", { name: "Go to next page", exact: true }).click();
  await expect(history.getByRole("link", { name: "Open cycle #91", exact: true })).toBeVisible();
});

test("switching tasks ignores a late history response from the previous task", async ({
  mount,
  page,
}) => {
  runs.push(run(94, 44));
  let release: (() => Promise<void>) | undefined;
  await page.route("**/api/cycle-runs?*", (route) => {
    if (new URL(route.request().url()).searchParams.get("task_id") === "42") {
      release = () => route.fulfill({ json: { items: [run(91, 42)], total: 1 } });
      return;
    }
    return route.fallback();
  });
  await mount("App/GlobalSearch");
  await page.getByRole("link", { name: "Tasks", exact: true }).click();
  await page.getByText("History active task", { exact: true }).click();
  await expect.poll(() => Boolean(release)).toBe(true);
  await page.getByText("History empty task", { exact: true }).click();
  const history = page.getByRole("region", { name: "Cycle history" });
  await expect(history.getByRole("link", { name: "Open cycle #94", exact: true })).toBeVisible();
  if (!release) throw new Error("No pending first-task response");
  await release();
  await page.waitForLoadState("networkidle");
  await expect(history.getByRole("link", { name: "Open cycle #91", exact: true })).toHaveCount(0);
  await expect(history.getByRole("link", { name: "Open cycle #94", exact: true })).toBeVisible();
});

test("task with no runs has an honest empty history", async ({ mount, page }) => {
  await mount("App/GlobalSearch");
  await page.evaluate(() => {
    window.location.hash = "/tasks?task_id=44";
  });
  await expect(page.getByRole("region", { name: "Cycle history" })).toContainText(
    "No cycles recorded for this task.",
  );
  await page
    .getByRole("region", { name: "Cycle history" })
    .getByRole("link", { name: "View all cycles for this task" })
    .click();
  await expect(page.getByText("No cycles recorded for this task.", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open task", exact: true })).toHaveAttribute(
    "href",
    "#/tasks?task_id=44",
  );
});
