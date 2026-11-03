import { spawn } from "node:child_process";
import { readdir, stat, unlink } from "node:fs/promises";
import { basename, delimiter, join, resolve } from "node:path";

/** Fail fast when the stopgap Python preflights cannot run at all: without
 * this check a missing interpreter degrades into permanent, undiagnosable
 * per-script "could not be executed" errors. Git is required for config
 * repository synchronization. */
export async function verifyPreflightTools(): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn("python3", ["-c", "import sys, urllib.request, json; sys.exit(0)"], { stdio: "ignore" });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectPromise(new Error("python3 check timed out"));
    }, 30_000);
    child.on("error", () => {
      clearTimeout(timer);
      rejectPromise(new Error("python3 is not available"));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise();
      else rejectPromise(new Error("python3 is not functional"));
    });
  });
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn("git", ["--version"], { stdio: "ignore" });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectPromise(new Error("git check timed out"));
    }, 30_000);
    child.on("error", () => {
      clearTimeout(timer);
      rejectPromise(new Error("git is not available"));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise();
      else rejectPromise(new Error("git is not functional"));
    });
  });
}

export type WorkPreflightScriptResult = {
  name: string;
  status: "start" | "skip" | "error";
  content: string;
};

export type WorkPreflightResult =
  | { action: "no-scripts"; scripts: [] }
  | { action: "start"; prompt: string; scripts: WorkPreflightScriptResult[] }
  | { action: "skip" | "error"; transcript: string; scripts: WorkPreflightScriptResult[] };

export interface WorkPreflightOptions {
  botRoot: string;
  workflow: string;
  instanceDir?: string;
  /** Pre-validated preflight directories (prefer the private runtime copies); skips path re-resolution. */
  preflightDirs?: { workflow?: string; instance?: string };
  /** Defaults to the parent environment, as in the Python runner. */
  env?: NodeJS.ProcessEnv;
  /** Per-script deadline and per-stream output cap. Defaults: 120 seconds and 1 MiB. */
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
}

async function listScripts(dir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") return [];
    throw error;
  }
  const files: string[] = [];
  // Python Path ordering compares Unicode code points, not locale or UTF-16 units.
  const compare = (a: string, b: string) => {
    const left = Array.from(a, (c) => c.codePointAt(0)!);
    const right = Array.from(b, (c) => c.codePointAt(0)!);
    for (let i = 0; i < Math.min(left.length, right.length); i++) {
      if (left[i] !== right[i]) return left[i] - right[i];
    }
    return left.length - right.length;
  };
  for (const name of names.filter((name) => name !== ".py" && name.endsWith(".py")).sort(compare)) {
    const file = join(dir, name);
    try {
      if ((await stat(file)).isFile()) files.push(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return files;
}

function failure(name: string, reason: string): WorkPreflightScriptResult {
  return { name, status: "error", content: `${name} ${reason}` };
}

async function runScript(script: string, root: string, env: NodeJS.ProcessEnv, timeoutMs: number, limit: number, signal?: AbortSignal): Promise<WorkPreflightScriptResult> {
  const name = basename(script);
  if (signal?.aborted) return failure(name, "cancelled");
  return new Promise((done) => {
    let child;
    try {
      child = spawn("python3", [script], { cwd: root, env, stdio: ["inherit", "pipe", "pipe"], detached: process.platform !== "win32" });
    } catch {
      done(failure(name, "could not be executed"));
      return;
    }
    let reason: string | undefined;
    let stdoutSize = 0;
    let stderrSize = 0;
    const chunks: Buffer[] = [];
    const stop = (why: string) => {
      if (reason) return;
      reason = why;
      // Kill the group as well: Python scripts may launch subprocesses inheriting pipes.
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch { child.kill("SIGKILL"); }
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const timer = setTimeout(() => stop(`timed out after ${timeoutMs}ms`), timeoutMs);
    const abort = () => stop("cancelled");
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutSize += chunk.length;
      if (stdoutSize > limit) stop("exceeded stdout limit");
      else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrSize += chunk.length;
      if (stderrSize > limit) stop("exceeded stderr limit");
    });
    child.stdout.on("error", () => stop("stdout read failed"));
    child.stderr.on("error", () => stop("stderr read failed"));
    child.on("error", () => { reason ??= "could not be executed"; });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (reason) return done(failure(name, reason));
      if (code !== 0) return done(failure(name, "exited unsuccessfully"));
      let stdout: string;
      try { stdout = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)).trim(); }
      catch { return done(failure(name, "returned invalid UTF-8")); }
      if (!stdout) return done(failure(name, "produced no output"));
      let value: unknown;
      try { value = JSON.parse(stdout); } catch { return done(failure(name, "returned invalid JSON")); }
      if (!value || typeof value !== "object" || Array.isArray(value)) return done(failure(name, "returned invalid JSON object"));
      const data = value as Record<string, unknown>;
      if (data.status !== "start" && data.status !== "skip" && data.status !== "error") return done(failure(name, "returned unknown status"));
      if (data.content !== undefined && typeof data.content !== "string") return done(failure(name, "returned invalid content"));
      const content = (data.content as string | undefined) ?? "";
      if (data.status === "start" && !content) return done(failure(name, "returned start with empty content"));
      return done({ name, status: data.status, content });
    });
  });
}

/** Run once per bot root at a time: scripts share data/preflight-state.json.
 * Results contain script-provided content and must not be logged without redaction. */
export async function runWorkPreflight(options: WorkPreflightOptions): Promise<WorkPreflightResult> {
  const root = resolve(options.botRoot);
  const instance = options.instanceDir ? resolve(options.instanceDir) : undefined;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const limit = options.maxOutputBytes ?? 1024 * 1024;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647 || !Number.isSafeInteger(limit) || limit <= 0) {
    throw new RangeError("Invalid work preflight limits");
  }
  if (options.workflow.startsWith("./") && !instance) {
    return { action: "error", transcript: "Relative workflow requires an instance directory", scripts: [] };
  }
  const workflowDir = options.workflow.startsWith("./")
    ? resolve(instance!, options.workflow.slice(2))
    : resolve(root, "presets", "workflows", options.workflow);
  const workflowPreflight = options.preflightDirs?.workflow ?? join(workflowDir, "preflight");
  const instancePreflight = options.preflightDirs?.instance ?? (instance ? join(instance, "preflight") : undefined);
  let scripts: string[];
  try {
    scripts = await listScripts(workflowPreflight);
    if (instancePreflight) scripts.push(...await listScripts(instancePreflight));
  } catch {
    return { action: "error", transcript: "Preflight discovery failed", scripts: [] };
  }
  if (!scripts.length) return { action: "no-scripts", scripts: [] };
  const env = { ...(options.env ?? process.env) };
  env.PYTHONDONTWRITEBYTECODE = "1";
  env.PYTHONPATH = [join(root, "presets", "shared", "preflight"), join(root, ".claude", "skills"), ...(env.PYTHONPATH ? [env.PYTHONPATH] : [])].join(delimiter);
  const results: WorkPreflightScriptResult[] = [];
  const stateFile = join(root, "data", "preflight-state.json");
  // A prior process may have crashed before its cleanup. Never reuse its state.
  try {
    await unlink(stateFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { action: "error", transcript: "Preflight state cleanup failed", scripts: results };
  }
  for (const script of scripts) {
    if (options.signal?.aborted) break;
    results.push(await runScript(script, root, env, timeoutMs, limit, options.signal));
  }
  try {
    await unlink(stateFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { action: "error", transcript: "Preflight state cleanup failed", scripts: results };
  }
  if (options.signal?.aborted) return { action: "error", transcript: "Preflight cancelled", scripts: results };
  const ok = results.filter((result) => result.status !== "error");
  const errors = results.filter((result) => result.status === "error");
  if (!ok.length) return { action: "error", transcript: results.map((result) => result.content).filter(Boolean).join("\n\n"), scripts: results };
  const content = ok.map((result) => result.content).filter(Boolean).join("\n\n");
  const summary = errors.map((error) => `[PREFLIGHT ERROR] ${error.name}: ${Array.from(error.content).slice(0, 200).join("")}`).join("\n");
  const combined = summary ? (content ? `${summary}\n\n${content}` : summary) : content;
  if (ok.some((result) => result.status === "start")) return { action: "start", prompt: combined, scripts: results };
  return { action: "skip", transcript: combined, scripts: results };
}
