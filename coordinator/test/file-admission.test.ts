import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { FileCycleAdmission } from "../src/adapters/file-admission";

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

  it("removes a stale PID lock but never steals a live owner", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rehor-admission-"));
    const path = join(directory, ".lock");
    await writeFile(path, "999999999\n", "utf8");

    const admission = new FileCycleAdmission(path);
    const lease = await admission.acquire(new AbortController().signal);
    expect(lease).not.toBeNull();
    if (!lease) throw new Error("stale admission did not acquire");
    await lease.release();
  });
});
