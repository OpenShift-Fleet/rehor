import test from "node:test";
import assert from "node:assert/strict";
import { access, copyFile, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { preparePreflightRuntime } from "../dist/preflight-runtime.js";
import { runWorkPreflight } from "../dist/work-preflight.js";

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

test("symlinked preflight scripts and imports resolve inside the private runtime", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "preflight-symlink-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const botRoot = join(root, "bot");
  const instanceDir = join(root, "agent");
  const workflowDir = join(botRoot, "presets", "workflows", "onboarding");
  const shared = join(botRoot, "presets", "shared", "preflight");
  for (const dir of [shared, join(botRoot, ".claude", "skills"), join(workflowDir, "preflight"), join(instanceDir, "preflight"), join(botRoot, "data")]) {
    await mkdir(dir, { recursive: true });
  }
  // The shared root map must never win over the instance map.
  await writeFile(join(botRoot, "project-repos.json"), '{"shared":{}}');
  await writeFile(join(instanceDir, "project-repos.json"), '{"instance":{}}');
  const source = fileURLToPath(new URL("../../../", import.meta.url));
  await copyFile(join(source, "presets/shared/preflight/common.py"), join(shared, "common.py"));
  // An in-boundary symlink target, as discovery accepts: Python 3.11+ resolves
  // the script's real path for sys.path[0], so the copy must be materialized.
  await writeFile(join(shared, "target.py"), `import json\nfrom common import load_project_repos, save_state, load_state, output_result\nsave_state({"marker": "written"})\noutput_result("skip", json.dumps({"repos": load_project_repos(), "state": load_state()}))\n`);
  await symlink(join(shared, "target.py"), join(workflowDir, "preflight", "01-check.py"));
  await writeFile(join(instanceDir, "preflight", "02-instance.py"), `import json\nfrom common import load_state, output_result\noutput_result("skip", json.dumps({"state": load_state()}))\n`);
  const profile = { botRoot, instanceDir, workflowDir, workflow: "onboarding",
    workflowPreflightDir: join(workflowDir, "preflight"), instancePreflightDir: join(instanceDir, "preflight") };
  const runtime = await preparePreflightRuntime(profile);
  try {
    // The runtime copy is a regular file, not a symlink.
    const copied = await lstat(join(runtime.preflightDirs.workflow, "01-check.py"));
    assert.ok(copied.isFile());
    const result = await runWorkPreflight({ botRoot: runtime.botRoot, workflow: "onboarding", instanceDir, preflightDirs: runtime.preflightDirs, env: { PATH: process.env.PATH } });
    assert.equal(result.action, "skip");
    const [first, second] = result.scripts.map((script) => JSON.parse(script.content));
    // The instance map is authoritative and shared state stays in the runtime.
    assert.deepEqual(first.repos, { instance: {} });
    assert.deepEqual(first.state, { marker: "written" });
    assert.deepEqual(second.state, { marker: "written" });
    await assert.rejects(access(join(botRoot, "data", "preflight-state.json")));
  } finally {
    await runtime.dispose();
  }
  await assert.rejects(access(runtime.botRoot));
});
