import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { FileCycleAdmission } from "../src/adapters/file-admission";

const PYTHON_LOCK_SCRIPT = `
import fcntl, os, sys
fd = os.open(sys.argv[1], os.O_CREAT | os.O_RDWR, 0o666)
try:
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    print("blocked", flush=True)
    raise SystemExit(0)
print("acquired", flush=True)
sys.stdin.read()
`;

describe("FileCycleAdmission", () => {
  it("allows one owner and releases the lock", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rehor-admission-"));
    const path = join(directory, ".lock");
    const first = new FileCycleAdmission(path);
    const second = new FileCycleAdmission(path);

    const lease = await first.acquire(new AbortController().signal);
    expect(lease).not.toBeNull();
    await expect(second.acquire(new AbortController().signal)).resolves.toBeNull();
    if (!lease) throw new Error("first admission did not acquire");

    await lease.release();
    await expect(second.acquire(new AbortController().signal)).resolves.not.toBeNull();
  });

  it("denies coordinator admission while Python holds flock on the empty lock file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rehor-admission-"));
    const path = join(directory, ".lock");
    const python = spawn(process.env.PYTHON ?? "python3", ["-c", PYTHON_LOCK_SCRIPT, path], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    try {
      await waitForLine(python, "acquired");
      await expect(
        new FileCycleAdmission(path).acquire(new AbortController().signal),
      ).resolves.toBeNull();
    } finally {
      python.stdin.end();
      await waitForClose(python);
    }
  });

  it("uses the same flock protocol so Python cannot enter while the coordinator owns the lock", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rehor-admission-"));
    const path = join(directory, ".lock");
    const admission = new FileCycleAdmission(path);
    const lease = await admission.acquire(new AbortController().signal);
    expect(lease).not.toBeNull();
    if (!lease) throw new Error("coordinator did not acquire the lock");

    const probe = `
import fcntl, os, sys
fd = os.open(sys.argv[1], os.O_CREAT | os.O_RDWR, 0o666)
try:
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    print("blocked")
else:
    print("acquired")
`;
    try {
      expect(
        execFileSync(process.env.PYTHON ?? "python3", ["-c", probe, path], {
          encoding: "utf8",
        }).trim(),
      ).toBe("blocked");
    } finally {
      await lease.release();
    }

    expect(
      execFileSync(process.env.PYTHON ?? "python3", ["-c", probe, path], {
        encoding: "utf8",
      }).trim(),
    ).toBe("acquired");
  });

  it("acquires an existing lock file when no process holds flock", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rehor-admission-"));
    const path = join(directory, ".lock");
    await writeFile(path, "", "utf8");

    const lease = await new FileCycleAdmission(path).acquire(new AbortController().signal);
    expect(lease).not.toBeNull();
    await lease?.release();
  });
});

function waitForLine(child: ReturnType<typeof spawn>, expected: string): Promise<void> {
  const stdout = child.stdout;
  if (!stdout) throw new Error("python lock helper stdout is unavailable");
  return new Promise((resolve, reject) => {
    let output = "";
    stdout.on("data", (chunk: Buffer | string) => {
      output += String(chunk);
      if (output.includes(`${expected}\n`)) resolve();
    });
    child.once("error", reject);
    child.once("close", (code) =>
      reject(new Error(`python lock helper exited before ready: ${code}`)),
    );
  });
}

function waitForClose(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", () => resolve());
  });
}
