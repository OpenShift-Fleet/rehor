import test from "node:test";
import assert from "node:assert/strict";
import { access, copyFile, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
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
    const result = await runWorkPreflight({ botRoot: runtime.botRoot, workflow: "onboarding", instanceDir, preflightDirs: runtime.preflightDirs, helperDir: runtime.helperDir, env: { PATH: process.env.PATH } });
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

test("private preflight imports dispatcher Jira client before script, shared, skills and inherited paths", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "preflight-jira-isolation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const botRoot = join(root, "bot");
  const instanceDir = join(root, "agent");
  const workflowDir = join(botRoot, "presets", "workflows", "test");
  const shared = join(botRoot, "presets", "shared", "preflight");
  const skills = join(botRoot, ".claude", "skills");
  const extra = join(root, "extra");
  for (const dir of [shared, skills, join(workflowDir, "preflight"), instanceDir, extra]) await mkdir(dir, { recursive: true });
  // A symlinked script resolves into shared, where Python normally searches first.
  await writeFile(join(shared, "target.py"), `import json, os, sys\npath = sys.path.copy()\nsys.path.insert(0, ${JSON.stringify(extra)})\nimport jira_mcp\nprint(json.dumps({'status': 'skip', 'content': json.dumps({'module': jira_mcp.__file__, 'path': path, 'env_path': os.environ['PYTHONPATH']})}))\n`);
  await symlink(join(shared, "target.py"), join(workflowDir, "preflight", "01.py"));
  for (const dir of [shared, skills, extra]) await writeFile(join(dir, "jira_mcp.py"), "raise RuntimeError('agent helper imported')\n");
  const runtime = await preparePreflightRuntime({ botRoot, instanceDir, workflowDir, workflow: "test", workflowPreflightDir: join(workflowDir, "preflight") });
  try {
    await assert.rejects(access(join(runtime.botRoot, ".claude", "skills", "jira_mcp.py")), { code: "ENOENT" });
    const result = await runWorkPreflight({ botRoot: runtime.botRoot, workflow: "test", preflightDirs: runtime.preflightDirs, helperDir: runtime.helperDir, env: { PATH: process.env.PATH, PYTHONPATH: extra } });
    assert.equal(result.action, "skip", JSON.stringify(result));
    const data = JSON.parse(result.scripts[0].content);
    assert.equal(data.module, join(runtime.helperDir, "jira_mcp.py"));
    assert.equal(data.path[0], runtime.helperDir);
    assert.ok(data.path[1].endsWith("/presets/workflows/test/preflight"));
    assert.equal(data.env_path.split(delimiter)[0], runtime.helperDir);
    assert.equal(await readFile(join(skills, "jira_mcp.py"), "utf8"), "raise RuntimeError('agent helper imported')\n");
    await rm(join(runtime.helperDir, "jira_mcp.py"));
    assert.equal((await runWorkPreflight({ botRoot: runtime.botRoot, workflow: "test", preflightDirs: runtime.preflightDirs, helperDir: runtime.helperDir, env: { PATH: process.env.PATH, PYTHONPATH: extra } })).action, "error");
  } finally { await runtime.dispose(); }
  await assert.rejects(access(runtime.botRoot), { code: "ENOENT" });
});

test("memory credential belongs to private dispatcher transport, not shared preflight", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "preflight-memory-auth-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const botRoot = join(root, "bot");
  const instanceDir = join(root, "agent");
  const workflowDir = join(botRoot, "presets", "workflows", "test");
  const shared = join(botRoot, "presets", "shared", "preflight");
  for (const dir of [shared, join(botRoot, ".claude", "skills"), join(workflowDir, "preflight"), instanceDir, join(botRoot, "data")]) await mkdir(dir, { recursive: true });
  const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
  await copyFile(join(repoRoot, "presets/shared/preflight/common.py"), join(shared, "common.py"));
  await writeFile(join(workflowDir, "preflight", "01.py"), `from common import get_tasks, output_result\noutput_result('skip', str(len(get_tasks())))\n`);
  const requests = [];
  let status = 200;
  const server = createServer((req, res) => {
    requests.push({ url: req.url, authorization: req.headers.authorization });
    res.writeHead(status, { "content-type": "application/json", ...(status === 302 ? { location: "/stolen" } : {}) });
    res.end('{"items": []}');
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const env = { PATH: process.env.PATH, BOT_MEMORY_URL: `http://127.0.0.1:${server.address().port}`, BOT_MEMORY_TOKEN: "synthetic-dispatcher-token" };
  const legacy = await runWorkPreflight({ botRoot, workflow: "test", env });
  assert.equal(legacy.action, "skip");
  assert.equal(requests[0].authorization, undefined);
  const runtime = await preparePreflightRuntime({ botRoot, instanceDir, workflowDir, workflow: "test", workflowPreflightDir: join(workflowDir, "preflight") });
  try {
    const options = { botRoot: runtime.botRoot, workflow: "test", preflightDirs: runtime.preflightDirs, helperDir: runtime.helperDir, env };
    assert.equal((await runWorkPreflight(options)).action, "skip");
    assert.equal(requests[1].authorization, "Bearer synthetic-dispatcher-token");
    status = 401;
    assert.equal((await runWorkPreflight(options)).action, "error");
    status = 403;
    assert.equal((await runWorkPreflight(options)).action, "error");
    status = 302;
    const count = requests.length;
    await runWorkPreflight(options);
    assert.equal(requests.length, count + 1, "authorization must not follow redirects");
    assert.ok(requests.every((request) => request.url.startsWith("/api/tasks?")));
  } finally { await runtime.dispose(); }
  // Pinned config repositories may still contain the older shared token hook.
  // The private adapter disables it before handling non-memory URLs.
  const oldCommon = (await readFile(join(shared, "common.py"), "utf8"))
    .replace("def http_get(url, timeout=10):", `def _auth_headers():\n    return {"Authorization": "Bearer " + os.environ.get("BOT_MEMORY_TOKEN", "")}\n\n\ndef http_get(url, timeout=10):`)
    .replace("req = urllib.request.Request(url)", "req = urllib.request.Request(url, headers=_auth_headers())");
  await writeFile(join(shared, "common.py"), oldCommon);
  await writeFile(join(workflowDir, "preflight", "01.py"), `import os\nfrom common import http_get, output_result\nhttp_get(os.environ['BOT_MEMORY_URL'] + '/other')\noutput_result('skip', 'ok')\n`);
  status = 200;
  const older = await preparePreflightRuntime({ botRoot, instanceDir, workflowDir, workflow: "test", workflowPreflightDir: join(workflowDir, "preflight") });
  try {
    const result = await runWorkPreflight({ botRoot: older.botRoot, workflow: "test", preflightDirs: older.preflightDirs, helperDir: older.helperDir, env });
    assert.equal(result.action, "skip");
    assert.equal(requests.at(-1).url, "/other");
    assert.equal(requests.at(-1).authorization, undefined);
  } finally { await older.dispose(); }
});
