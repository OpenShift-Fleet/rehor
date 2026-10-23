import { expect, test } from "../../e2e/fixtures";
import fixtures from "../test/fixtures.json" with { type: "json" };
import type { Task } from "../types";

const base = fixtures.tasks["RHCLOUD-001"] as Task;
let tasks: Task[];
test.beforeEach(async ({ page }) => {
  tasks = Array.from({ length: 62 }, (_, i) => ({
    ...base,
    id: i + 1,
    external_key: `FILTER-${i + 1}`,
    title: `Needle item ${i + 1}`,
    summary: "",
    repo: "org/project",
    instance_id: "demo-alpha",
    status: i < 30 ? "in_progress" : i < 60 ? "done" : "archived",
  }));
  tasks.push(
    ...Array.from({ length: 60 }, (_, i) => ({
      ...base,
      id: 65 + i,
      external_key: `ARCHIVE-${i + 1}`,
      title: `Archive needle item ${i + 1}`,
      summary: "",
      repo: "org/project",
      instance_id: i === 59 ? "other-bot" : "demo-alpha",
      status: "archived" as const,
    })),
  );
  tasks.push(
    { ...base, id: 63, title: "Unrelated task", summary: "", status: "in_progress" },
    { ...base, id: 64, title: "Another named task", summary: "", status: "done" },
    {
      ...base,
      id: 125,
      external_key: "ARCHIVE-ANOTHER",
      title: "Another archived task",
      summary: "",
      instance_id: "demo-alpha",
      status: "archived",
    },
  );
  await page.route("**/api/**", (route) => {
    const u = new URL(route.request().url()),
      p = u.searchParams;
    let json: unknown = { items: [], total: 0 };
    if (u.pathname === "/api/instances") json = [];
    if (route.request().method() === "POST" && u.pathname.endsWith("/unarchive")) {
      const key = decodeURIComponent(u.pathname.split("/")[3]);
      tasks = tasks.map((task) =>
        task.external_key === key ? { ...task, status: "in_progress" } : task,
      );
      json = { ok: true };
    }
    if (u.pathname === "/api/stats")
      json = { tasks: { in_progress: 31, done: 31, archived: 63 }, memories: { total: 0 } };
    if (u.pathname === "/api/tasks") {
      const needle = (p.get("q") || "").trim().toLowerCase();
      const rows = tasks
        .filter(
          (t) =>
            (!p.has("task_id") || t.id === Number(p.get("task_id"))) &&
            (!p.has("status") || t.status === p.get("status")) &&
            (!p.has("exclude_status") ||
              (p.has("status") && !p.has("q")) ||
              t.status !== p.get("exclude_status")) &&
            (!p.has("instance_id") || t.instance_id === p.get("instance_id")) &&
            (!needle ||
              [t.external_key, t.title, t.summary, t.repo, t.instance_id].some((s) =>
                s?.toLowerCase().includes(needle),
              )),
        )
        .sort((a, b) => b.id - a.id);
      const offset = Number(p.get("offset") || 0),
        limit = Number(p.get("limit") || 20);
      json = { items: rows.slice(offset, offset + limit), total: rows.length };
    }
    return route.fulfill({ json });
  });
});

test("task search excludes archives across every page and preserves selected status", async ({
  mount,
  page,
}) => {
  await mount("App/GlobalSearch");
  const input = page.getByRole("searchbox", { name: "Search all instances" });
  await input.fill("needle");
  await expect(page).toHaveURL(/#\/tasks\?q=needle$/);
  await expect(page.getByText("60 matching tasks", { exact: true })).toBeVisible();
  await expect(page.getByText("Needle item 60", { exact: true })).toBeVisible();
  await expect(page.getByText("Needle item 62", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Global search results" })).toHaveCount(0);
  for (let pageIndex = 0; pageIndex < 2; pageIndex++) {
    await page.getByRole("button", { name: "Go to next page", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`page=${pageIndex + 2}`));
  }
  await expect(page.getByText("Needle item 1", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "All", exact: true }).click();
  await expect(page.getByRole("option", { name: "Archived", exact: true })).toHaveCount(0);
  await page.getByRole("option", { name: "Done", exact: true }).click();
  await expect(page.getByText("30 matching tasks", { exact: true })).toBeVisible();
  await expect(page.getByText("Needle item 60", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Go to next page", exact: true }).click();
  await expect(page.getByText("Needle item 31", { exact: true })).toBeVisible();
  await input.fill("another");
  await expect(page).toHaveURL(/status=done/);
  await expect(page).toHaveURL(/q=another/);
  await expect(page).not.toHaveURL(/page=/);
  await expect(page.getByText("1 matching task", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Done", exact: true })).toBeVisible();
  await expect(page.getByText("Another named task", { exact: true })).toBeVisible();
});

test("a removed Archived status in an old Tasks URL cannot bypass the current list scope", async ({
  mount,
  page,
}) => {
  await mount("App/GlobalSearch");
  await page.evaluate(() => {
    window.location.hash = "/tasks?status=archived";
  });
  await expect(page.getByText("Another named task", { exact: true })).toBeVisible();
  await expect(page.getByText("Another archived task", { exact: true })).toHaveCount(0);
  await page.getByRole("searchbox").fill("needle");
  await expect(page.getByText("60 matching tasks", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Clear global search" }).click();
  await expect(page.getByText("Another named task", { exact: true })).toBeVisible();
  await expect(page.getByText("Another archived task", { exact: true })).toHaveCount(0);
});

test("query, status and page survive reload and browser history; clear preserves status", async ({
  mount,
  page,
}) => {
  await mount("App/GlobalSearch");
  const input = page.getByRole("searchbox", { name: "Search all instances" });
  await input.fill("needle");
  await expect(page.getByText("60 matching tasks", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Go to next page", exact: true }).click();
  await expect(page.getByText("Needle item 40", { exact: true })).toBeVisible();
  await page.reload();
  await page.waitForFunction("typeof window.mount === 'function'");
  await mount("App/GlobalSearch");
  await expect(input).toHaveValue("needle");
  await expect(page.getByText("Needle item 40", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "All", exact: true }).click();
  await page.getByRole("option", { name: "Done", exact: true }).click();
  await expect(page.getByText("30 matching tasks", { exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByText("Needle item 40", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "All", exact: true })).toBeVisible();
  await page.goForward();
  await expect(page.getByText("30 matching tasks", { exact: true })).toBeVisible();
  await page.reload();
  await page.waitForFunction("typeof window.mount === 'function'");
  await mount("App/GlobalSearch");
  await expect(input).toHaveValue("needle");
  await expect(page.getByRole("button", { name: "Done", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Clear global search" }).click();
  await expect(page).toHaveURL(/#\/tasks\?status=done$/);
  await expect(input).toBeFocused();
  await expect(page.getByText("Another named task", { exact: true })).toBeVisible();
});

test("archived search cards keep details and history, with Restore-only actions on mobile", async ({
  mount,
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await mount("App/GlobalSearch");
  await page.getByRole("link", { name: "Archive", exact: true }).click();
  await page.getByRole("searchbox").fill("filter-");
  await expect(page).toHaveURL(/#\/archived\?q=filter-$/);
  await expect(page.getByText("2 matching archived tasks", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "FILTER-62", exact: true }).click();
  await expect(page.getByRole("button", { name: "Restore Task", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^(Archive|Pause|Unpause) Task$/ })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Cycle history" })).toBeVisible();
  await expect(page.getByText("No cycles recorded for this task.", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test("Archive searches every archived page and retains its URL/query through reload, clear and history", async ({
  mount,
  page,
}) => {
  await mount("App/GlobalSearch");
  await page.getByRole("link", { name: "Archive", exact: true }).click();
  const input = page.getByRole("searchbox", { name: "Search archived tasks", exact: true });
  await input.fill("needle");
  await expect(page.getByText("62 matching archived tasks", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "FILTER-60", exact: true })).toHaveCount(0);
  for (const p of [2, 3, 4]) {
    await page.getByRole("button", { name: "Go to next page", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`page=${p}`));
  }
  await expect(page.getByRole("button", { name: "FILTER-61", exact: true })).toBeVisible();
  await page.reload();
  await page.waitForFunction("typeof window.mount === 'function'");
  await mount("App/GlobalSearch");
  await expect(input).toHaveValue("needle");
  await expect(page.getByRole("button", { name: "FILTER-61", exact: true })).toBeVisible();
  await input.fill("another");
  await expect(page.getByText("1 matching archived task", { exact: true })).toBeVisible();
  await expect(page).not.toHaveURL(/page=/);
  await expect(page.getByText("Another archived task", { exact: true })).toBeVisible();
  await expect(page.getByText("Another named task", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Clear global search" }).click();
  await expect(page).toHaveURL(/#\/archived$/);
  await expect(input).toBeFocused();
  await expect(page.getByText("63 archived tasks", { exact: true })).toBeVisible();
  await page.goBack();
  await expect(input).toHaveValue("another");
  await expect(page.getByText("1 matching archived task", { exact: true })).toBeVisible();
  await page.goBack();
  await expect(input).toHaveValue("needle");
  await expect(page.getByRole("button", { name: "FILTER-61", exact: true })).toBeVisible();
  await page.goForward();
  await expect(input).toHaveValue("another");
  await expect(page.getByText("Another archived task", { exact: true })).toBeVisible();
});

test("switching lists uses the destination scope, not the previous search results", async ({
  mount,
  page,
}) => {
  await mount("App/GlobalSearch");
  await page.getByRole("searchbox").fill("needle");
  await expect(page.getByText("60 matching tasks", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Archive", exact: true }).click();
  const archive = page.getByRole("searchbox", { name: "Search archived tasks", exact: true });
  await expect(archive).toHaveValue("");
  await archive.fill("needle");
  await expect(page.getByText("62 matching archived tasks", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Tasks", exact: true }).click();
  await expect(page.getByRole("searchbox", { name: "Search all instances" })).toHaveValue("");
  await expect(page.getByText("Another named task", { exact: true })).toBeVisible();
  await expect(page.getByText("Another archived task", { exact: true })).toHaveCount(0);
});

test("Archive search stays within the selected instance", async ({ mount, page }) => {
  await mount("App/GlobalSearch");
  await page.evaluate(() => {
    window.location.hash = "/instances/demo-alpha/archived";
  });
  const input = page.getByRole("searchbox", { name: "Search archived tasks in this instance" });
  await input.fill("needle");
  await expect(page.getByText("61 matching archived tasks", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/#\/instances\/demo-alpha\/archived\?q=needle$/);
  await input.fill("other-bot");
  await expect(page.getByText("0 matching archived tasks", { exact: true })).toBeVisible();
});

test("selected instance and In Progress intersect with the search", async ({ mount, page }) => {
  await mount("App/GlobalSearch");
  await page.evaluate(() => {
    window.location.hash = "/instances/demo-alpha/tasks?status=in_progress";
  });
  const input = page.getByRole("searchbox", { name: "Search tasks in this instance" });
  await input.fill("needle");
  await expect(page.getByText("30 matching tasks", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "In Progress", exact: true })).toBeVisible();
  await input.fill("another");
  await expect(page.getByText("0 matching tasks", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/#\/instances\/demo-alpha\/tasks\?/);
  await expect(page).toHaveURL(/status=in_progress/);
});

for (const view of ["tasks", "archived"]) {
  test(`${view}: failed reads retry honestly; empty/short input never displays unfiltered cards`, async ({
    mount,
    page,
  }) => {
    const archived = view === "archived",
      noun = archived ? "archived tasks" : "tasks",
      empty = archived ? "No archived tasks" : "No tasks found";
    let failed = true;
    const queries: string[] = [];
    await page.route("**/api/tasks?*", (route) => {
      const q = new URL(route.request().url()).searchParams.get("q");
      if (q) queries.push(q);
      return failed && q === "needle"
        ? route.fulfill({ status: 503, json: { error: "offline" } })
        : route.fallback();
    });
    await mount("App/GlobalSearch");
    if (archived) await page.getByRole("link", { name: "Archive", exact: true }).click();
    const input = page.getByRole("searchbox");
    await input.fill("needle");
    await expect(page.getByRole("alert")).toContainText(`Could not load ${noun}`);
    await expect(page.getByText(empty, { exact: true })).toHaveCount(0);
    failed = false;
    await page.getByRole("button", { name: `Retry ${noun}`, exact: true }).click();
    await expect(
      page.getByText(`${archived ? 62 : 60} matching ${noun}`, { exact: true }),
    ).toBeVisible();
    await input.fill("zzzzzz");
    await expect(page.getByText(`0 matching ${noun}`, { exact: true })).toBeVisible();
    await expect(page.getByText(empty, { exact: true })).toBeVisible();
    await input.fill("r");
    await expect(page.getByText("Type at least 2 characters.", { exact: true })).toBeVisible();
    expect(queries).not.toContain("r");
    await expect(page.getByText(empty, { exact: true })).toHaveCount(0);
  });
}

test("restoring an archived match refreshes Archive without losing the query", async ({
  mount,
  page,
}) => {
  await mount("App/GlobalSearch");
  await page.getByRole("link", { name: "Archive", exact: true }).click();
  await page.getByRole("searchbox").fill("filter-");
  await expect(page.getByText("2 matching archived tasks", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "FILTER-62", exact: true }).click();
  await page.getByRole("button", { name: "Restore Task", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Restore", exact: true }).click();
  await expect(page.getByText("1 matching archived task", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "FILTER-62", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "FILTER-61", exact: true })).toBeVisible();
  await expect(page.getByRole("searchbox")).toHaveValue("filter-");
  await expect(page).toHaveURL(/#\/archived\?q=filter-$/);
});

for (const view of ["tasks", "archived"]) {
  for (const oldStatus of [200, 503]) {
    test(`${view}: a late ${oldStatus} response cannot replace current query results`, async ({
      mount,
      page,
    }) => {
      let release = () => {},
        finish = () => {};
      const gate = new Promise<void>((resolve) => {
          release = resolve;
        }),
        finished = new Promise<void>((resolve) => {
          finish = resolve;
        });
      await page.route("**/api/tasks?*", async (route) => {
        if (new URL(route.request().url()).searchParams.get("q") !== "needle")
          return route.fallback();
        await gate;
        await route.fulfill({
          status: oldStatus,
          json:
            oldStatus === 200
              ? {
                  items: [tasks.find((t) => t.id === (view === "archived" ? 61 : 1))],
                  total: view === "archived" ? 62 : 60,
                }
              : { error: "offline" },
        });
        finish();
      });
      await mount("App/GlobalSearch");
      if (view === "archived")
        await page.getByRole("link", { name: "Archive", exact: true }).click();
      const latest = view === "archived" ? "Another archived task" : "Another named task";
      const input = page.getByRole("searchbox");
      const request = page.waitForRequest(
        (req) => new URL(req.url()).searchParams.get("q") === "needle",
      );
      await input.fill("needle");
      await request;
      await expect(
        page.getByText(view === "archived" ? "Loading archived tasks…" : "Loading tasks…", {
          exact: true,
        }),
      ).toBeVisible();
      await input.fill("another");
      await expect(page.getByText(latest, { exact: true })).toBeVisible();
      release();
      await finished;
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
      await expect(page.getByText(latest, { exact: true })).toBeVisible();
      await expect(page.getByRole("alert")).toHaveCount(0);
      await expect(
        page.getByText(view === "archived" ? "Needle item 61" : "Needle item 1", { exact: true }),
      ).toHaveCount(0);
    });
  }
}
