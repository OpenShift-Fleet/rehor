import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("dispatcher Jira MCP compatibility client contract", () => {
  const result = spawnSync("python3", [fileURLToPath(new URL("./test_jira_client.py", import.meta.url))], {
    encoding: "utf8", env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: "1" },
  });
  assert.equal(result.status, 0, result.stderr);
});
