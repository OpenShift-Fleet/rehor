import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import type { CycleAdmission, CycleAdmissionLease } from "../ports/loop";

const PYTHON_FLOCK = `
import fcntl, os, sys
fd = os.open(sys.argv[1], os.O_CREAT | os.O_RDWR, 0o666)
try:
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    raise SystemExit(75)
sys.stdout.write("locked\\n")
sys.stdout.flush()
sys.stdin.buffer.read()
fcntl.flock(fd, fcntl.LOCK_UN)
os.close(fd)
`;

/** Filesystem admission using the same POSIX flock protocol as Python FileLock. */
export class FileCycleAdmission implements CycleAdmission {
  constructor(
    private readonly lockPath: string,
    private readonly pythonExecutable = "python3",
  ) {}

  async acquire(signal: AbortSignal): Promise<CycleAdmissionLease | null> {
    if (signal.aborted) return null;
    await mkdir(dirname(this.lockPath), { recursive: true });
    if (signal.aborted) return null;

    const child = spawn(this.pythonExecutable, ["-c", PYTHON_FLOCK, this.lockPath], {
      env: { PATH: process.env.PATH ?? "" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.on("error", () => undefined);

    let stderr = "";
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
    });

    let resolveClosed!: (value: { code: number; signal: NodeJS.Signals | null }) => void;
    const closed = new Promise<{ code: number; signal: NodeJS.Signals | null }>((resolve) => {
      resolveClosed = resolve;
    });
    child.once("close", (code, exitSignal) =>
      resolveClosed({ code: code ?? -1, signal: exitSignal }),
    );

    return new Promise((resolve, reject) => {
      let settled = false;
      let output = "";
      const settle = (action: () => void): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        action();
      };
      const onAbort = (): void => {
        child.kill("SIGTERM");
      };
      const fail = (error: Error): void => settle(() => reject(error));

      signal.addEventListener("abort", onAbort, { once: true });
      child.stdout.on("data", (chunk: Buffer | string) => {
        output += String(chunk);
        if (!output.includes("locked\n")) return;
        if (signal.aborted) {
          child.stdin.end();
          settle(() => resolve(null));
          return;
        }
        settle(() =>
          resolve({
            release: async () => {
              child.stdin.end();
              const exit = await closed;
              if (exit.code !== 0) {
                throw new Error(
                  `Python flock helper exited with code ${exit.code}${stderr ? `: ${stderr.trim()}` : ""}`,
                );
              }
            },
          }),
        );
      });
      child.once("error", fail);
      child.once("close", (code, exitSignal) => {
        if (settled) return;
        if (signal.aborted || code === 75) {
          settle(() => resolve(null));
          return;
        }
        const detail =
          stderr.trim() || `exit code ${code ?? -1}${exitSignal ? ` (${exitSignal})` : ""}`;
        settle(() => reject(new Error(`Python flock helper failed: ${detail}`)));
      });
      if (signal.aborted) onAbort();
    });
  }
}
