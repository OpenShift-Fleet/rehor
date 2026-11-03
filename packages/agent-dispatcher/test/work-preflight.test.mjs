import test from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runWorkPreflight } from "../dist/work-preflight.js";

async function fixture(t) {
  const botRoot = await mkdtemp(join(tmpdir(), "work-preflight-test-"));
  t.after(() => rm(botRoot, { recursive: true, force: true }));
  const workflowDir = join(botRoot, "presets", "workflows", "test", "preflight");
  const instanceDir = join(botRoot, "instance");
  await mkdir(workflowDir, { recursive: true });
  await mkdir(join(instanceDir, "preflight"), { recursive: true });
  await mkdir(join(botRoot, "data"), { recursive: true });
  const options = { botRoot, workflow: "test", instanceDir, env: { PATH: process.env.PATH } };
  const script = (dir, name, source) => writeFile(join(dir, name), source);
  return { botRoot, workflowDir, instanceDir, options, script };
}

test("no scripts is explicit and missing relative workflow configuration is an error", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await runWorkPreflight(f.options), { action: "no-scripts", scripts: [] });
  assert.equal((await runWorkPreflight({ ...f.options, workflow: "./custom", instanceDir: undefined })).action, "error");
});

test("abort stops a running Python preflight without starting another script", async (t) => {
  const f = await fixture(t);
  await f.script(f.workflowDir, "01.py", "import time\ntime.sleep(60)\n");
  await f.script(f.workflowDir, "02.py", "raise RuntimeError('must not run')\n");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 100);
  try {
    const result = await runWorkPreflight({ ...f.options, signal: controller.signal });
    assert.equal(result.action, "error");
    assert.equal(result.transcript, "Preflight cancelled");
    assert.ok(result.scripts.length <= 1);
  } finally { clearTimeout(timer); }
});

test("workflow then instance scripts run in lexical order, sharing state, cwd, imports and environment", async (t) => {
  const f = await fixture(t);
  const shared = join(f.botRoot, "presets", "shared", "preflight");
  const skills = join(f.botRoot, ".claude", "skills");
  const extra = join(f.botRoot, "extra");
  await Promise.all([shared, skills, extra].map((dir) => mkdir(dir, { recursive: true })));
  await writeFile(join(shared, "shared_fixture.py"), 'value = "shared"\n');
  await writeFile(join(skills, "skill_fixture.py"), 'value = "skill"\n');
  await writeFile(join(extra, "extra_fixture.py"), 'value = "extra"\n');
  const body = (id, status) => `import json, os, shared_fixture, skill_fixture, extra_fixture\nassert os.getcwd() == os.path.realpath(${JSON.stringify(f.botRoot)})\nassert os.environ['FIXTURE'] == 'available'\nassert os.environ['PYTHONDONTWRITEBYTECODE'] == '1'\nassert os.environ['PYTHONPATH'].split(os.pathsep) == ${JSON.stringify([shared, skills, extra])}\n${id === "C" ? "assert open('data/preflight-state.json').read() == 'AB'\n" : ""}with open('data/preflight-state.json', 'a') as state: state.write('${id}')\nprint(json.dumps({'status': '${status}', 'content': '${id}'}))\n`;
  await f.script(f.workflowDir, "20.py", body("B", "skip"));
  await f.script(f.workflowDir, "10.py", body("A", "start"));
  await f.script(join(f.instanceDir, "preflight"), "01.py", body("C", "skip"));
  await f.script(f.workflowDir, "ignored.txt", "raise RuntimeError()\n");
  await mkdir(join(f.workflowDir, "directory.py"));
  await writeFile(join(f.botRoot, "data", "preflight-state.json"), "stale");
  const result = await runWorkPreflight({ ...f.options, env: { ...f.options.env, PYTHONPATH: extra, FIXTURE: "available", PYTHONDONTWRITEBYTECODE: "0" } });
  assert.equal(result.action, "start", JSON.stringify(result));
  assert.equal(result.prompt, "A\n\nB\n\nC");
  assert.deepEqual(result.scripts.map((s) => s.name), ["10.py", "20.py", "01.py"]);
  await assert.rejects(readFile(join(f.botRoot, "data", "preflight-state.json")), { code: "ENOENT" });
  await assert.rejects(stat(join(shared, "__pycache__")), { code: "ENOENT" });
  await assert.rejects(stat(join(skills, "__pycache__")), { code: "ENOENT" });
  assert.equal(delimiter.length, 1);
});

test("partial errors do not block start or skip, and error summaries precede all successful content", async (t) => {
  const f = await fixture(t);
  await f.script(f.workflowDir, "01.py", `print('{"status":"error","content":"API unavailable"}')`);
  await f.script(f.workflowDir, "02.py", `print('{"status":"skip","content":"nothing"}')`);
  await f.script(f.workflowDir, "03.py", `print('{"status":"start","content":"work"}')`);
  const result = await runWorkPreflight(f.options);
  assert.equal(result.action, "start");
  assert.equal(result.prompt, "[PREFLIGHT ERROR] 01.py: API unavailable\n\nnothing\n\nwork");
  await f.script(f.workflowDir, "03.py", `print('{"status":"skip"}')`);
  const skip = await runWorkPreflight(f.options);
  assert.equal(skip.action, "skip");
  assert.equal(skip.transcript, "[PREFLIGHT ERROR] 01.py: API unavailable\n\nnothing");
});

test("all errors fail, without exposing malformed stdout or process stderr", async (t) => {
  const f = await fixture(t);
  await f.script(f.workflowDir, "01.py", `print('sensitive-invalid-output')`);
  await f.script(f.workflowDir, "02.py", `import sys\nopen('data/preflight-state.json', 'w').write('must be removed')\nprint('sensitive-stderr', file=sys.stderr)\nsys.exit(1)`);
  const result = await runWorkPreflight(f.options);
  assert.equal(result.action, "error");
  assert.deepEqual(result.scripts.map((s) => s.status), ["error", "error"]);
  assert.match(result.transcript, /invalid JSON/);
  assert.doesNotMatch(JSON.stringify(result), /sensitive/);
  await assert.rejects(stat(join(f.botRoot, "data", "preflight-state.json")), { code: "ENOENT" });
});

test("checked-in onboarding preflight runs against hermetic memory and fake Jira for start and skip", async (t) => {
  const f = await fixture(t);
  const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const workflowDir = join(f.botRoot, "presets", "workflows", "onboarding", "preflight");
  const shared = join(f.botRoot, "presets", "shared", "preflight");
  const skills = join(f.botRoot, ".claude", "skills");
  await Promise.all([workflowDir, shared, skills].map((dir) => mkdir(dir, { recursive: true })));
  // These checked-in files match onboarding's pinned dev-bot revision 38e6cace24d4c97c35f2e55d89d2d1752b5f653a.
  await Promise.all([
    copyFile(join(repoRoot, "presets/workflows/onboarding/preflight/03-onboarding-jira.py"), join(workflowDir, "03-onboarding-jira.py")),
    ...["common.py", "onboarding_preflight.py"].map((name) => copyFile(join(repoRoot, "presets/shared/preflight", name), join(shared, name))),
  ]);
  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ items: [] }));
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const port = server.address().port;
  // The only permitted outbound socket is the in-process memory fixture.
  await writeFile(join(shared, "sitecustomize.py"), `import socket\n_original = socket.socket.connect\ndef _local_only(sock, address):\n    if not isinstance(address, tuple) or address[0] != '127.0.0.1' or address[1] != ${port}:\n        raise RuntimeError('external network disabled')\n    return _original(sock, address)\nsocket.socket.connect = _local_only\nsocket.socket.connect_ex = lambda *args: (_ for _ in ()).throw(RuntimeError('external network disabled'))\n`);
  await writeFile(join(skills, "jira_mcp.py"), `import json, os\ndef jira_call(name, args):\n    assert name == 'jira_search'\n    assert 'labels = "fixture-label"' in args['jql']\n    with open('data/jira-calls.jsonl', 'a') as f: f.write(json.dumps({'name': name, 'args': args}) + '\\n')\n    return {'issues': [{'key': 'REHOR-123', 'fields': {'summary': 'Synthetic candidate', 'status': {'name': 'New'}, 'labels': ['fixture-label']}}]} if os.environ['FIXTURE_WORK'] == 'yes' else {'issues': []}\ndef jira_cleanup():\n    pass\n`);
  const env = { PATH: process.env.PATH, BOT_MEMORY_URL: `http://127.0.0.1:${port}`, BOT_INSTANCE_ID: "fixture-instance", BOT_LABEL: "fixture-label", BOT_JIRA_PROJECT: "REHOR", FIXTURE_WORK: "yes" };
  const options = { botRoot: f.botRoot, workflow: "onboarding", env };
  const start = await runWorkPreflight(options);
  assert.equal(start.action, "start", JSON.stringify(start));
  assert.match(start.prompt, /REHOR-123.*Synthetic candidate/);
  assert.match(start.prompt, /CAPACITY: 0\/10/);
  assert.equal(requests.length, 2);
  assert.ok(requests.every((url) => url.startsWith("/api/tasks?") && url.includes("instance_id=fixture-instance")));
  await assert.rejects(stat(join(f.botRoot, "data", "preflight-state.json")), { code: "ENOENT" });
  const skip = await runWorkPreflight({ ...options, env: { ...env, FIXTURE_WORK: "no" } });
  assert.equal(skip.action, "skip", JSON.stringify(skip));
  assert.match(skip.transcript, /No active tasks and no new candidates/);
  assert.equal(requests.length, 4);
  assert.equal((await readFile(join(f.botRoot, "data", "jira-calls.jsonl"), "utf8")).trim().split("\n").length, 2);
  await assert.rejects(stat(join(f.botRoot, "data", "preflight-state.json")), { code: "ENOENT" });
  await assert.rejects(stat(join(shared, "__pycache__")), { code: "ENOENT" });
  await assert.rejects(stat(join(skills, "__pycache__")), { code: "ENOENT" });
});

test("validates status, content, empty output and JSON shape", async (t) => {
  const f = await fixture(t);
  for (const [i, source] of ["pass", "print('[]')", `print('{"status":"unknown"}')`, `print('{"status":"start"}')`, `print('{"status":"start","content":23}')`, `print('{"status":"skip","content":null}')`].entries()) {
    await f.script(f.workflowDir, `${i}.py`, source);
  }
  const result = await runWorkPreflight(f.options);
  assert.equal(result.action, "error");
  assert.equal(result.scripts.length, 6);
  assert.ok(result.scripts.every((s) => s.status === "error"));
});

test("relative custom workflow, symlinked files, and all skip", async (t) => {
  const f = await fixture(t);
  const dir = join(f.instanceDir, "custom", "preflight");
  await mkdir(dir, { recursive: true });
  await f.script(f.workflowDir, "source.py", `print('{"status":"skip","content":"custom"}')`);
  await symlink(join(f.workflowDir, "source.py"), join(dir, "link.py"));
  const result = await runWorkPreflight({ ...f.options, workflow: "./custom" });
  assert.equal(result.action, "skip");
  assert.equal(result.transcript, "custom");
});

test("timeouts, stream caps and spawn errors fail without blocking the event loop", async (t) => {
  const f = await fixture(t);
  await f.script(f.workflowDir, "01.py", "import time\ntime.sleep(10)");
  let ticked = false;
  const timer = setTimeout(() => { ticked = true; }, 10);
  const timeout = await runWorkPreflight({ ...f.options, timeoutMs: 150 });
  clearTimeout(timer);
  assert.equal(ticked, true);
  assert.equal(timeout.action, "error");
  assert.match(timeout.transcript, /timed out/);
  await f.script(f.workflowDir, "01.py", `print('x' * 10000)`);
  const stdout = await runWorkPreflight({ ...f.options, maxOutputBytes: 100 });
  assert.match(stdout.transcript, /stdout limit/);
  await f.script(f.workflowDir, "01.py", `import sys\nprint('x' * 10000, file=sys.stderr)`);
  const stderr = await runWorkPreflight({ ...f.options, maxOutputBytes: 100 });
  assert.match(stderr.transcript, /stderr limit/);
  const spawn = await runWorkPreflight({ ...f.options, env: { PATH: "" } });
  assert.equal(spawn.action, "error");
  assert.match(spawn.transcript, /could not be executed/);
});
