import assert from "node:assert/strict";
import test from "node:test";
import {
  HCC_WEEKLY_REPORT_INPUT,
  runHccWeeklyReport,
} from "../dist/preflights/hcc-weekly-report/index.js";
import { createMemoryServerClient } from "../dist/shared/memory-server.js";
import { isWithinLocalWindow } from "../dist/shared/schedule.js";

const WEEKLY_WINDOW = { days: [0, 1], startHour: 7, endHour: 21, timeZone: "Europe/Prague" };

test("the local weekday decides across midnight UTC", () => {
  const window = { ...WEEKLY_WINDOW, startHour: 0, endHour: 23 };
  assert.equal(isWithinLocalWindow(new Date("2026-07-19T23:30:00Z"), window), true);
  assert.equal(isWithinLocalWindow(new Date("2026-07-21T22:30:00Z"), window), false);
});

test("invalid schedule configuration fails closed", () => {
  for (const fields of [{ timeZone: "Prague" }, { startHour: 21 }, { days: [7] }]) {
    assert.throws(() =>
      isWithinLocalWindow(new Date("2026-07-20T09:00:00Z"), {
        ...WEEKLY_WINDOW,
        ...fields,
      }),
    );
  }
});

test("weekly report honors the inclusive open, exclusive close, and Prague DST", async () => {
  const cases = [
    ["2026-01-05T05:00:00Z", null], // Monday 06:00 CET
    ["2026-01-05T06:00:00Z", "2026-01-09"],
    ["2026-07-20T04:59:59Z", null],
    ["2026-07-20T05:00:00Z", "2026-07-24"], // Monday 07:00 CEST
    ["2026-07-20T18:59:59Z", "2026-07-24"],
    ["2026-07-20T19:00:00Z", null],
    ["2026-07-22T09:00:00Z", null], // Wednesday inside the hours
  ];
  const params = HCC_WEEKLY_REPORT_INPUT.parse({ repo: "org/weekly-status" });
  for (const [iso, friday] of cases) {
    let memoryCalls = 0;
    const memory = createMemoryServerClient({
      baseUrl: "http://memory.test",
      fetch: async () => {
        memoryCalls += 1;
        return Response.json({ items: [] });
      },
    });
    const result = await runHccWeeklyReport(
      { memory, github: {}, now: () => new Date(iso) },
      params,
    );
    assert.equal(result.status, friday ? "start" : "skip", iso);
    if (friday) {
      assert.match(result.content, /## TASK: weekly-report-generate/);
      assert.ok(result.content.includes(`weekly-report-${friday}`), iso);
    } else {
      assert.equal(memoryCalls, 0, iso);
    }
  }
});
