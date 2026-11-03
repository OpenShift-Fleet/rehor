import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseConfigRepositories, syncConfigRepositories } from "../dist/config-repositories.js";

test("repository list rejects credentials, ambiguous names and unsafe URL forms without echoing them", () => {
  const invalid = [
    '["https://alice:secret@example.com/private.git"]',
    '["https://alice@example.com/private.git"]',
    '["https://example.com/private.git?token=secret"]',
    '["git@example.com:private.git"]',
    '["file:///private.git"]',
    '["https://example.com/a/repo.git", "https://other.example/b/repo.git"]',
    '"https://example.com/repo.git"',
    'invalid secret',
  ];
  for (const value of invalid) {
    assert.throws(() => parseConfigRepositories(value), (error) => !error.message.includes("secret") && !error.message.includes("alice"));
  }
  assert.deepEqual(parseConfigRepositories('["https://example.com/team/onboarding.git"]'), [
    { name: "onboarding", url: "https://example.com/team/onboarding.git" },
  ]);
  // SSH URLs commonly carry a username; only credentials are rejected.
  assert.deepEqual(parseConfigRepositories('["ssh://git@github.com/team/onboarding.git"]'), [
    { name: "onboarding", url: "ssh://git@github.com/team/onboarding.git" },
  ]);
  assert.throws(() => parseConfigRepositories('["ssh://git:secret@github.com/team/onboarding.git"]'));
  assert.throws(() => parseConfigRepositories('["https://git@github.com/team/onboarding.git"]'));
});

test("sync snapshots default HEAD and pinned submodules, reuses intact checkouts and preserves last good on failure", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "config-repositories-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const oldEnv = { ...process.env };
  t.after(() => {
    for (const key of ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "PATH", "GIT_TEST_REAL_GIT", "GIT_TEST_COMMAND_LOG"]) {
      if (oldEnv[key] === undefined) delete process.env[key];
      else process.env[key] = oldEnv[key];
    }
  });

  // Rewrite fixture HTTPS URLs to local repositories and permit file transport
  // only in this test's private Git configuration, including submodule clones.
  const config = join(root, "gitconfig");
  process.env.GIT_CONFIG_GLOBAL = config;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  const run = (cwd, ...args) => execFileSync("git", args, { cwd, env: process.env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  run(root, "config", "--global", "user.name", "Test");
  run(root, "config", "--global", "user.email", "test@example.invalid");
  run(root, "config", "--global", "protocol.file.allow", "always");
  run(root, "config", "--global", `url.${pathToFileURL(`${root}/`).href}.insteadOf`, "https://fixture.invalid/");

  const child = join(root, "child");
  const parent = join(root, "onboarding");
  run(root, "init", "-b", "main", child);
  await writeFile(join(child, "preflight.sh"), "first\n");
  run(child, "add", ".");
  run(child, "commit", "-m", "first child");
  const pinned = run(child, "rev-parse", "HEAD");
  run(root, "clone", "--bare", child, join(root, "child.git"));
  run(root, "init", "-b", "main", parent);
  await writeFile(join(parent, "config"), "first\n");
  run(parent, "add", ".");
  run(parent, "commit", "-m", "first parent");
  run(parent, "submodule", "add", "https://fixture.invalid/child.git", "dev-bot");
  run(parent, "commit", "-am", "pin child");
  run(root, "clone", "--bare", parent, join(root, "onboarding.git"));
  const repositories = parseConfigRepositories('["https://fixture.invalid/onboarding.git"]');
  const syncRoot = join(root, "snapshots");
  const sync = async () => (await syncConfigRepositories(syncRoot, repositories))[0];

  // Record only operation names, never arguments or Git output.
  const bin = join(root, "bin");
  await mkdir(bin);
  process.env.GIT_TEST_REAL_GIT = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  process.env.GIT_TEST_COMMAND_LOG = join(root, "operations");
  await writeFile(join(bin, "git"), '#!/bin/sh\ncase "$1:$2" in clone:*|submodule:update) printf "%s\\n" "$1" >> "$GIT_TEST_COMMAND_LOG";; esac\nexec "$GIT_TEST_REAL_GIT" "$@"\n', { mode: 0o755 });
  process.env.PATH = `${bin}:${oldEnv.PATH}`;

  const first = await sync();
  assert.equal(first.revision, run(parent, "rev-parse", "HEAD"));
  assert.equal(run(join(first.path, "dev-bot"), "rev-parse", "HEAD"), pinned);
  assert.equal(await readFile(join(first.path, "dev-bot", "preflight.sh"), "utf8"), "first\n");
  const operations = await readFile(process.env.GIT_TEST_COMMAND_LOG, "utf8");
  assert.deepEqual(await sync(), first);
  assert.deepEqual(await Promise.all([sync(), sync()]), [first, first]);
  assert.equal(await readFile(process.env.GIT_TEST_COMMAND_LOG, "utf8"), operations);

  await rm(first.path, { recursive: true });
  const restored = await sync();
  assert.notEqual(restored.path, first.path);
  assert.equal(restored.revision, first.revision);

  // A newer submodule HEAD alone must not change the parent's pinned checkout.
  await writeFile(join(child, "preflight.sh"), "second\n");
  run(child, "commit", "-am", "new child");
  run(child, "push", join(root, "child.git"), "main");
  assert.deepEqual(await sync(), restored);

  await writeFile(join(parent, "config"), "second\n");
  run(parent, "commit", "-am", "new parent");
  run(parent, "push", join(root, "onboarding.git"), "main");
  const second = await sync();
  assert.notEqual(second.path, restored.path);
  assert.notEqual(second.revision, restored.revision);
  assert.equal(await readFile(join(restored.path, "config"), "utf8"), "first\n");
  assert.equal(await readFile(join(second.path, "config"), "utf8"), "second\n");
  assert.equal(run(join(second.path, "dev-bot"), "rev-parse", "HEAD"), pinned);

  await rm(join(second.path, "dev-bot"), { recursive: true });
  const repaired = await sync();
  assert.notEqual(repaired.path, second.path);
  assert.equal(repaired.revision, second.revision);
  assert.equal(await readFile(join(repaired.path, "dev-bot", "preflight.sh"), "utf8"), "first\n");

  const stateDir = join(syncRoot, (await readdir(syncRoot))[0]);
  const stateBefore = await readFile(join(stateDir, "current.json"), "utf8");
  run(parent, "config", "-f", ".gitmodules", "submodule.dev-bot.url", "https://fixture.invalid/missing-private.git");
  run(parent, "add", ".gitmodules");
  run(parent, "commit", "-m", "broken submodule");
  run(parent, "push", join(root, "onboarding.git"), "main");
  await assert.rejects(sync(), (error) => error.message === "Git repository synchronization failed" && !error.message.includes("missing-private"));
  assert.equal(await readFile(join(stateDir, "current.json"), "utf8"), stateBefore);
  assert.equal(await readFile(join(repaired.path, "config"), "utf8"), "second\n");
  assert.equal((await readdir(stateDir)).filter((name) => name.startsWith("snapshot-")).length, 3);

  // Superseded snapshots older than the grace period are pruned on the next
  // publish; recent ones are kept for in-flight consumers.
  const stale = new Date(Date.now() - 2 * 60 * 60_000);
  await utimes(restored.path, stale, stale);
  run(parent, "config", "-f", ".gitmodules", "submodule.dev-bot.url", "https://fixture.invalid/child.git");
  run(parent, "add", ".gitmodules");
  run(parent, "commit", "-m", "restore submodule");
  run(parent, "push", join(root, "onboarding.git"), "main");
  const fourth = await sync();
  assert.notEqual(fourth.path, repaired.path);
  await assert.rejects(access(restored.path));
  await access(second.path);
  await access(repaired.path);
  assert.equal((await readdir(stateDir)).filter((name) => name.startsWith("snapshot-")).length, 3);
});
