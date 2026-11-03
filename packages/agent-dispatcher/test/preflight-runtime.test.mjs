import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { preparePreflightRuntime } from "../dist/preflight-runtime.js";

test("preflight runtime uses instance repo map without merging or modifying checkout", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "preflight-runtime-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const botRoot = join(root, "bot");
  const instanceDir = join(root, "agent");
  const workflowDir = join(botRoot, "presets", "workflows", "onboarding");
  for (const dir of [join(botRoot, "presets", "shared", "preflight"), join(botRoot, ".claude", "skills"), join(workflowDir, "preflight"), instanceDir]) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(join(botRoot, "project-repos.json"), '{"shared":{}}');
  await writeFile(join(instanceDir, "project-repos.json"), '{"instance":{}}');
  const runtime = await preparePreflightRuntime({ botRoot, instanceDir, workflowDir, workflow: "onboarding" });
  try {
    assert.deepEqual(JSON.parse(await readFile(join(runtime.botRoot, "project-repos.json"), "utf8")), { instance: {} });
    await writeFile(join(runtime.botRoot, "data", "preflight-state.json"), "test");
    await assert.rejects(access(join(botRoot, "data", "preflight-state.json")));
    assert.deepEqual(JSON.parse(await readFile(join(botRoot, "project-repos.json"), "utf8")), { shared: {} });
  } finally {
    await runtime.dispose();
  }
  await assert.rejects(access(runtime.botRoot));
});
