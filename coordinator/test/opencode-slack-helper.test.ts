import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { buildOpenCodeEnvironment } from "../src/runtimes/opencode/environment";

const fixture = fileURLToPath(new URL("./fixtures/slack-helper-capture.py", import.meta.url));
const helper = fileURLToPath(
  new URL("../../presets/envs/slack/skills/slack-notify/slack_notify.py", import.meta.url),
);

it.each(["batch", "immediate"])(
  "passes the inherited configured webhook and %s mode from the canonical helper to MCP",
  (mode) => {
    const webhook = "http://127.0.0.1:18080/synthetic-webhook";
    const result = runHelper({ SLACK_WEBHOOK_URL: webhook, SLACK_NOTIFY_MODE: mode });
    expect(result).toEqual({
      calls: [
        {
          name: "slack_notify",
          arguments: {
            external_key: "SYNTHETIC-199",
            event_type: "pr_created",
            message: "Synthetic notification",
            webhook_url: webhook,
            notify_mode: mode,
          },
        },
      ],
      cleanups: 1,
      result: { sent: true, fixture: "MCP argument capture only" },
    });
  },
);

it.each([undefined, ""])("keeps canonical helper optional no-op for webhook %s", (webhook) => {
  expect(runHelper({ SLACK_WEBHOOK_URL: webhook, SLACK_NOTIFY_MODE: "batch" })).toEqual({
    calls: [],
    cleanups: 0,
    result: { sent: false, reason: "SLACK_WEBHOOK_URL not set" },
  });
});

function runHelper(base: NodeJS.ProcessEnv): unknown {
  const result = spawnSync(process.env.PYTHON ?? "python3", [fixture, helper], {
    env: buildOpenCodeEnvironment({ base: { PATH: process.env.PATH, ...base } }),
    encoding: "utf8",
    timeout: 10000,
  });
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}
