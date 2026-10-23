import { expect, test } from "../../e2e/fixtures";
import fixtures from "../test/fixtures.json" with { type: "json" };
import type { Task } from "../types";

const base = fixtures.tasks["RHCLOUD-001"] as Task;
test.beforeEach(async ({ page }) => {
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({
      json:
        path === "/api/stats"
          ? { tasks: {}, memories: { total: 0 } }
          : path === "/api/instances" || path === "/api/memories/search"
            ? []
            : { items: [], total: 0 },
    });
  });
});

test("one character, Enter and clear do not leave Cycles", async ({ mount, page }) => {
  await mount("App/GlobalSearch");
  await page.getByRole("link", { name: "Cycles", exact: true }).click();
  const input = page.getByRole("searchbox", { name: "Search all instances", exact: true });
  await input.fill("r");
  await input.press("Enter");
  await page.waitForTimeout(250);
  await expect(page).toHaveURL(/#\/cycles$/);
  await page.getByRole("button", { name: "Clear global search" }).click();
  await expect(page).toHaveURL(/#\/cycles$/);
  await input.fill("re");
  await expect(page).toHaveURL(/#\/tasks\?q=re$/);
});

test("masthead utilities stay at the right edge on wide and wrapped layouts", async ({
  mount,
  page,
}) => {
  await mount("App/GlobalSearch");
  const banner = page.getByRole("banner"),
    connection = banner.getByTitle(/^(Connected|Disconnected)$/);
  for (const width of [1440, 1024, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect
      .poll(async () => {
        const h = await banner.boundingBox(),
          s = await connection.boundingBox();
        if (!h || !s) throw new Error("Missing masthead geometry");
        return h.x + h.width - s.x - s.width;
      })
      .toBeLessThanOrEqual(32);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    );
  }
});

test("enabled PatternFly search has one internal clear control and no dropdown", async ({
  mount,
  page,
}) => {
  await mount("App/GlobalSearch");
  const banner = page.getByRole("banner"),
    input = banner.getByRole("searchbox", { name: "Search all instances" }),
    field = banner.locator(".pf-v6-c-text-input-group");
  await expect(input).toBeEditable();
  await expect(input).toHaveAttribute("maxlength", "200");
  await input.fill("review");
  await input.press("Enter");
  await expect(page).toHaveURL(/#\/tasks\?q=review$/);
  await expect(page.getByRole("region", { name: "Global search results" })).toHaveCount(0);
  const clear = banner.getByRole("button", { name: "Clear global search", exact: true });
  await expect(clear).toHaveCount(1);
  const f = await field.boundingBox(),
    c = await clear.boundingBox();
  if (!f || !c) throw new Error("Missing search geometry");
  expect(c.x).toBeGreaterThanOrEqual(f.x);
  expect(c.x + c.width).toBeLessThanOrEqual(f.x + f.width);
  await expect(input).toHaveAttribute("type", "text");
  await clear.click();
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("");
  await expect(clear).toHaveCount(0);
});

test("dedicated semantic memory search remains independent", async ({ mount, page }) => {
  await mount("App/GlobalSearch");
  await page.getByRole("link", { name: "Search", exact: true }).click();
  const memory = page.getByPlaceholder("Search memories...");
  await memory.fill("authentication");
  const request = page.waitForRequest("**/api/memories/search?*");
  await memory.press("Enter");
  await request;
  await expect(page.getByText("No results found", { exact: true })).toBeVisible();
  await page.getByRole("searchbox", { name: "Search all instances" }).fill("review");
  await expect(page).toHaveURL(/#\/tasks\?q=review$/);
});

for (const status of ["in_progress", "archived"] as const) {
  test(`canonical task navigation resolves ${status} details and stale location without page scanning`, async ({
    mount,
    page,
  }) => {
    const task = {
      ...base,
      id: 142,
      external_key: "TEST-142",
      title: "Search navigation target",
      status,
    };
    await page.route("**/api/tasks?*", (route) => {
      const focused = new URL(route.request().url()).searchParams.get("task_id") === "142";
      return route.fulfill({ json: { items: focused ? [task] : [], total: focused ? 1 : 0 } });
    });
    await mount("App/GlobalSearch");
    await page.evaluate(
      (hash) => {
        window.location.hash = hash;
      },
      status === "archived" ? "/tasks?task_id=142" : "/archived?task_id=142",
    );
    await expect(page).toHaveURL(
      status === "archived" ? /#\/archived\?task_id=142$/ : /#\/tasks\?task_id=142$/,
    );
    const action = page.getByRole("button", {
      name: status === "archived" ? "Restore Task" : "Archive Task",
      exact: true,
    });
    await expect(action).toBeVisible();
    await page.reload();
    await page.waitForFunction("typeof window.mount === 'function'");
    await mount("App/GlobalSearch");
    await expect(action).toBeVisible();
    const showAll = page.getByRole("button", {
      name: status === "archived" ? "Show all archived tasks" : "Show all tasks",
      exact: true,
    });
    await expect(showAll).toHaveClass(/pf-v6-c-button/);
    await expect(showAll).toHaveClass(/pf-m-secondary/);
    await showAll.click();
    await expect(page).not.toHaveURL(/task_id=/);
    await expect(action).not.toBeVisible();
  });
}
