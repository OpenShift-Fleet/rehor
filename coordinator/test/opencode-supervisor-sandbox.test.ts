import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { build } from "vite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenCodeProcessLeakError as PublicOpenCodeProcessLeakError } from "../src/index";
import {
  OpenCodeProcessLeakError,
  OpenCodeStartupCleanupError,
} from "../src/runtimes/opencode/process-leak-error";
import { OpenCodeServerSupervisor } from "../src/runtimes/opencode/process-supervisor";

class Child extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  pid: number | undefined = 987654;
  kill = vi.fn((_signal: NodeJS.Signals): boolean => true);
  unref = vi.fn();
}

function supervisor(child: Child, base?: NodeJS.ProcessEnv) {
  let detached: boolean | undefined;
  const instance = new OpenCodeServerSupervisor({
    base,
    workspaceRoot: process.cwd(),
    startupTimeoutMs: 40,
    shutdownTimeoutMs: 15,
    killVerificationTimeoutMs: 15,
    spawnProcess: (_command, _args, options) => {
      detached = options.detached;
      queueMicrotask(() => child.stdout.write('{"url":"http://127.0.0.1:41236"}\n'));
      return child as never;
    },
  });
  return { instance, detached: () => detached };
}

function readiness() {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    return Response.json(
      url.pathname === "/api/info"
        ? { version: "2.1.2", pid: 123, urls: [], paths: { tmp: "/tmp/opencode" } }
        : { directory: url.searchParams.get("location[directory]") },
    );
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("OpenCode sandbox supervisor shutdown", () => {
  it("closes the lease and escalates only the direct child, verifying exit", async () => {
    readiness();
    const child = new Child();
    child.kill.mockImplementation((signal) => {
      if (signal === "SIGKILL") child.emit("exit", null, signal);
      return true;
    });
    const groupKill = vi.spyOn(process, "kill");
    const h = supervisor(child, { REHOR_INPUT_SOURCE: "sandbox" });
    await h.instance.start(process.cwd(), new AbortController().signal);
    await h.instance.stop();
    expect(h.detached()).toBe(false);
    expect(child.stdin.writableEnded).toBe(true);
    expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
    expect(groupKill).not.toHaveBeenCalled();
  });

  it("never signals an exited child, including synchronous EOF and crash", async () => {
    readiness();
    const groupKill = vi.spyOn(process, "kill");
    const child = new Child();
    const h = supervisor(child, { REHOR_INPUT_SOURCE: "sandbox" });
    await h.instance.start(process.cwd(), new AbortController().signal);
    vi.spyOn(child.stdin, "end").mockImplementation(() => {
      child.emit("exit", 0, null);
      return child.stdin;
    });
    await h.instance.stop();
    expect(child.kill).not.toHaveBeenCalled();

    const crashed = new Child();
    const h2 = supervisor(crashed, { REHOR_INPUT_SOURCE: "sandbox" });
    await h2.instance.start(process.cwd(), new AbortController().signal);
    crashed.emit("exit", 1, null);
    expect(h2.instance.crashSignal.aborted).toBe(true);
    await h2.instance.stop();
    expect(crashed.kill).not.toHaveBeenCalled();
    expect(groupKill).not.toHaveBeenCalled();
  });

  it("verifies leader exit before close and releases pipes held by a descendant", async () => {
    readiness();
    let leader: ChildProcess | undefined;
    let descendant: number | undefined;
    let closeBeforeExit = false;
    const source = `
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'inherit'] });
      console.log('descendant:' + child.pid);
      process.on('SIGTERM', () => process.exit(0));
      console.log(JSON.stringify({url:'http://127.0.0.1:41236'}));
      setInterval(() => {}, 1000);
    `;
    const h = new OpenCodeServerSupervisor({
      base: { REHOR_INPUT_SOURCE: "sandbox" },
      workspaceRoot: process.cwd(),
      startupTimeoutMs: 1000,
      shutdownTimeoutMs: 500,
      spawnProcess: (_command, _args, options) => {
        leader = spawn(process.execPath, ["-e", source], options);
        let closed = false;
        leader.once("close", () => {
          closed = true;
        });
        leader.once("exit", () => {
          closeBeforeExit = closed;
        });
        leader.stdout?.on("data", (chunk: Buffer) => {
          const match = chunk.toString().match(/descendant:(\d+)/);
          if (match) descendant = Number(match[1]);
        });
        return leader;
      },
    });
    try {
      await h.start(process.cwd(), new AbortController().signal);
      expect(descendant).toBeGreaterThan(0);
      await h.stop();
      expect(closeBeforeExit).toBe(false);
      expect(leader?.stdout?.destroyed).toBe(true);
      expect(leader?.stderr?.destroyed).toBe(true);
      // Leader exit and pipe release say nothing about descendant lifetime.
      expect(() => process.kill(descendant as number, 0)).not.toThrow();
    } finally {
      if (descendant) process.kill(descendant, "SIGKILL");
      await h.stop();
    }
  });

  it("reports signal EPERM even when escalation subsequently exits", async () => {
    readiness();
    const child = new Child();
    child.kill.mockImplementation((signal) => {
      if (signal === "SIGTERM")
        child.emit("error", Object.assign(new Error("kill EPERM"), { code: "EPERM" }));
      else child.emit("exit", null, signal);
      return true;
    });
    const groupKill = vi.spyOn(process, "kill");
    const h = supervisor(child, { REHOR_INPUT_SOURCE: "sandbox" });
    await h.instance.start(process.cwd(), new AbortController().signal);
    await expect(h.instance.stop()).rejects.toThrow("EPERM");
    expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
    expect(groupKill).not.toHaveBeenCalled();
  });

  it("reports asynchronous signal errors after kill returns false", async () => {
    readiness();
    const child = new Child();
    child.kill.mockImplementation((signal) => {
      if (signal === "SIGTERM") {
        queueMicrotask(() =>
          child.emit("error", Object.assign(new Error("kill EPERM"), { code: "EPERM" })),
        );
        return false;
      }
      child.emit("exit", null, signal);
      return true;
    });
    const h = supervisor(child, { REHOR_INPUT_SOURCE: "sandbox" });
    await h.instance.start(process.cwd(), new AbortController().signal);
    await expect(h.instance.stop()).rejects.toThrow(/signal failed.*EPERM/);
  });

  it("does not treat an error or close event as leader exit; retains child for retry", async () => {
    expect(PublicOpenCodeProcessLeakError).toBe(OpenCodeProcessLeakError);
    readiness();
    const child = new Child();
    child.kill.mockImplementation((signal) => {
      if (signal === "SIGTERM") child.emit("error", new Error("signal failure"));
      else child.emit("close", null, signal);
      return true;
    });
    const h = supervisor(child, { REHOR_INPUT_SOURCE: "sandbox" });
    await h.instance.start(process.cwd(), new AbortController().signal);
    const error = await h.instance.stop().catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).message).toMatch(/signal failure.*exit was not verified/);
    expect(
      (error as AggregateError).errors.some((item) => item instanceof OpenCodeProcessLeakError),
    ).toBe(true);
    expect(child.unref).toHaveBeenCalled();
    expect(child.stdin.destroyed).toBe(true);
    expect(child.stdout.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
    child.kill.mockImplementation((signal) => {
      child.emit("exit", null, signal);
      return true;
    });
    await expect(h.instance.stop()).rejects.toThrow("signal failure");
    expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"], ["SIGTERM"]]);
  });

  it("lets a one-shot runner exit after failed signals leave a real child alive", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencode-supervisor-test-"));
    let runner: ChildProcess | undefined;
    let childPid: number | undefined;
    try {
      await build({
        configFile: false,
        logLevel: "silent",
        ssr: { noExternal: true },
        build: {
          outDir: directory,
          emptyOutDir: false,
          ssr: join(process.cwd(), "src/runtimes/opencode/process-supervisor.ts"),
          rollupOptions: {
            output: { entryFileNames: "supervisor.mjs", format: "es" },
          },
        },
      });
      const moduleUrl = pathToFileURL(join(directory, "supervisor.mjs")).href;
      const source = `
        import { spawn } from 'node:child_process';
        import { OpenCodeServerSupervisor } from ${JSON.stringify(moduleUrl)};
        globalThis.fetch = async input => {
          const url = new URL(input instanceof Request ? input.url : String(input));
          return Response.json(url.pathname === '/api/info'
            ? { version: '2.1.2', pid: 123, urls: [], paths: { tmp: '/tmp/opencode' } }
            : { directory: url.searchParams.get('location[directory]') });
        };
        const childSource = \`
          process.on('SIGTERM', () => {});
          console.log(JSON.stringify({url:'http://127.0.0.1:41236'}));
          setInterval(() => {}, 1000);
          setTimeout(() => process.exit(0), 30000);
        \`;
        const supervisor = new OpenCodeServerSupervisor({
          base: { REHOR_INPUT_SOURCE: 'sandbox' }, workspaceRoot: process.cwd(),
          startupTimeoutMs: 3000, shutdownTimeoutMs: 30, killVerificationTimeoutMs: 30,
          spawnProcess: (_command, _args, options) => {
            const child = spawn(process.execPath, ['-e', childSource], options);
            console.log('CHILD_PID=' + child.pid);
            child.kill = () => { throw Object.assign(new Error('kill EPERM'), {code:'EPERM'}); };
            return child;
          },
        });
        await supervisor.start(process.cwd(), new AbortController().signal);
        try { await supervisor.stop(); console.log('UNEXPECTED_SUCCESS'); }
        catch (error) { console.log('FAILURE=' + error.message); }
      `;
      runner = spawn(process.execPath, ["--input-type=module", "-e", source], {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      let stderr = "";
      runner.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        const match = output.match(/CHILD_PID=(\d+)/);
        if (match) childPid = Number(match[1]);
      });
      runner.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const timeout = setTimeout(() => runner?.kill("SIGKILL"), 5000);
      const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>(
        (resolve) => {
          runner?.once("close", (exitCode, exitSignal) => resolve([exitCode, exitSignal]));
        },
      );
      clearTimeout(timeout);
      expect({ code, signal, stderr }).toEqual({ code: 0, signal: null, stderr: "" });
      expect(output).toMatch(/FAILURE=.*EPERM.*exit was not verified/);
      expect(childPid).toBeGreaterThan(0);
      // Verify the exact child still exists; the test, not the supervisor, kills it.
      expect(() => process.kill(childPid as number, 0)).not.toThrow();
    } finally {
      if (runner?.exitCode === null && runner.signalCode === null) runner.kill("SIGKILL");
      if (childPid) {
        try {
          process.kill(childPid, "SIGKILL");
        } catch (error) {
          // biome-ignore lint/correctness/noUnsafeFinally: Preserve cleanup failures when the child cannot be killed.
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      }
      await rm(directory, { recursive: true, force: true });
    }
  }, 10000);

  it("handles late EPIPE after leader exit and reports stdin errors while alive", async () => {
    readiness();
    const exited = new Child();
    const first = supervisor(exited, { REHOR_INPUT_SOURCE: "sandbox" });
    await first.instance.start(process.cwd(), new AbortController().signal);
    exited.emit("exit", 1, null);
    exited.stdin.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    await expect(first.instance.stop()).resolves.toBeUndefined();
    exited.stdin.emit("error", Object.assign(new Error("late EPIPE"), { code: "EPIPE" }));

    const live = new Child();
    live.kill.mockImplementation((signal) => {
      queueMicrotask(() => {
        live.stdin.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
        live.emit("exit", null, signal);
      });
      return true;
    });
    const second = supervisor(live, { REHOR_INPUT_SOURCE: "sandbox" });
    await second.instance.start(process.cwd(), new AbortController().signal);
    await expect(second.instance.stop()).rejects.toThrow("EPIPE");
  });

  it("cleans up startup failure without group signals and preserves signal errors", async () => {
    const child = new Child();
    const signalError = Object.assign(new Error("kill EPERM private-cleanup-canary"), {
      code: "EPERM",
    });
    child.kill.mockImplementation((signal) => {
      if (signal === "SIGTERM") throw signalError;
      child.emit("exit", null, signal);
      return true;
    });
    const groupKill = vi.spyOn(process, "kill");
    const h = supervisor(child, { REHOR_INPUT_SOURCE: "sandbox" });
    const failure = await h.instance
      .start(process.cwd(), new AbortController().signal)
      .catch((error) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.message).toMatch(/startup failed.*permission denied/);
    expect(failure).toBeInstanceOf(OpenCodeStartupCleanupError);
    expect(failure.startupError).toBe(failure.errors[0]);
    expect(failure.cleanupError).toBe(signalError);
    expect(failure.message).not.toContain("private-cleanup-canary");
    expect(failure.errors[1]).toBe(signalError);
    expect(child.stdin.writableEnded).toBe(true);
    expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
    expect(groupKill).not.toHaveBeenCalled();
  });

  it("suppresses unclassified cleanup error text in startup failure", async () => {
    const child = new Child();
    const signalError = new Error("private-unclassified-canary");
    child.kill.mockImplementation((signal) => {
      if (signal === "SIGTERM") throw signalError;
      child.emit("exit", null, signal);
      return true;
    });
    const h = supervisor(child, { REHOR_INPUT_SOURCE: "sandbox" });
    const failure = await h.instance
      .start(process.cwd(), new AbortController().signal)
      .catch((error) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.message).toContain("unclassified runtime error (payload suppressed)");
    expect(failure.message).not.toContain("private-unclassified-canary");
    expect(failure.errors[1]).toBe(signalError);
  });

  it("handles a crash before readiness without signaling the exited PID", async () => {
    const child = new Child();
    const groupKill = vi.spyOn(process, "kill");
    const h = new OpenCodeServerSupervisor({
      base: { REHOR_INPUT_SOURCE: "sandbox" },
      workspaceRoot: process.cwd(),
      spawnProcess: () => {
        queueMicrotask(() => child.emit("exit", 1, null));
        return child as never;
      },
    });
    await expect(h.start(process.cwd(), new AbortController().signal)).rejects.toThrow(
      "exited before readiness",
    );
    expect(child.stdin.writableEnded).toBe(true);
    expect(child.kill).not.toHaveBeenCalled();
    expect(groupKill).not.toHaveBeenCalled();
  });

  it("coalesces concurrent stops without duplicate signals", async () => {
    readiness();
    const child = new Child();
    child.kill.mockImplementation((signal) => {
      queueMicrotask(() => child.emit("exit", null, signal));
      return true;
    });
    const h = supervisor(child, { REHOR_INPUT_SOURCE: "sandbox" });
    await h.instance.start(process.cwd(), new AbortController().signal);
    await Promise.all([h.instance.stop(), h.instance.stop()]);
    expect(child.kill.mock.calls).toEqual([["SIGTERM"]]);
  });

  it("handles asynchronous spawn failure without attempting any PID signal", async () => {
    const child = new Child();
    child.pid = undefined;
    const groupKill = vi.spyOn(process, "kill");
    const h = new OpenCodeServerSupervisor({
      base: { REHOR_INPUT_SOURCE: "sandbox" },
      workspaceRoot: process.cwd(),
      spawnProcess: () => {
        queueMicrotask(() =>
          child.emit("error", Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" })),
        );
        return child as never;
      },
    });
    const failure = await h
      .start(process.cwd(), new AbortController().signal)
      .catch((error) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.message).toContain("file not found");
    expect(failure.errors[0].message).toContain("spawn ENOENT");
    expect(child.kill).not.toHaveBeenCalled();
    expect(groupKill).not.toHaveBeenCalled();
  });

  it("uses the ambient sandbox setting when base is omitted", async () => {
    readiness();
    vi.stubEnv("REHOR_INPUT_SOURCE", "sandbox");
    const child = new Child();
    child.kill.mockImplementation((signal) => {
      child.emit("exit", null, signal);
      return true;
    });
    const groupKill = vi.spyOn(process, "kill");
    const h = supervisor(child);
    await h.instance.start(process.cwd(), new AbortController().signal);
    await h.instance.stop();
    expect(h.detached()).toBe(false);
    expect(groupKill).not.toHaveBeenCalled();
  });

  it("uses legacy detached process groups when explicit base excludes sandbox", async () => {
    readiness();
    vi.stubEnv("REHOR_INPUT_SOURCE", "sandbox");
    const child = new Child();
    const groupKill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      expect(pid).toBe(-987654);
      if (signal === 0) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      child.emit("exit", null, signal);
      return true;
    });
    const h = supervisor(child, {});
    await h.instance.start(process.cwd(), new AbortController().signal);
    await h.instance.stop();
    expect(h.detached()).toBe(process.platform !== "win32");
    expect(groupKill).toHaveBeenCalledWith(-987654, "SIGTERM");
    expect(child.kill).not.toHaveBeenCalled();
  });
});
