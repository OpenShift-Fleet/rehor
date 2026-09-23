import { type FileHandle, mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";

import type { CycleAdmission, CycleAdmissionLease } from "../ports/loop";

/** Filesystem admission compatible with the Python runner's data/.lock. */
export class FileCycleAdmission implements CycleAdmission {
  constructor(private readonly lockPath: string) {}

  async acquire(signal: AbortSignal): Promise<CycleAdmissionLease | null> {
    if (signal.aborted) return null;
    await mkdir(dirname(this.lockPath), { recursive: true });

    let handle: FileHandle;
    try {
      handle = await open(this.lockPath, "wx");
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      if (await liveOwner(this.lockPath)) return null;
      await unlink(this.lockPath).catch(() => undefined);
      try {
        handle = await open(this.lockPath, "wx");
      } catch (retryError) {
        if (isAlreadyExists(retryError)) return null;
        throw retryError;
      }
    }

    await handle.writeFile(`${process.pid}\n`, "utf8");
    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        await handle.close();
        await unlink(this.lockPath).catch(() => undefined);
      },
    };
  }
}

function isAlreadyExists(error: unknown): boolean {
  return isNodeError(error) && error.code === "EEXIST";
}

async function liveOwner(path: string): Promise<boolean> {
  let pid: number;
  try {
    const raw = (await readFile(path, "utf8")).trim();
    // A just-created lock can be observed before its owner writes its PID.
    // Treat empty or malformed contents as owned rather than stealing it.
    if (!raw) return true;
    const value = Number.parseInt(raw, 10);
    if (!Number.isSafeInteger(value) || value <= 0) return true;
    pid = value;
  } catch {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error) && error.code === "EPERM";
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
