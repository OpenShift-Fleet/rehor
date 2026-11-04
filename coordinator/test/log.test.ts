import { mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectBridgeDiagnostics, PythonCoordinatorBridge } from "../src/bridges/python";
import { classifyDiagnostic, providerDiagnostic, runtimeErrorDetails } from "../src/diagnostics";
import {
  createFileLogger,
  createStructuredLogger,
  errorDetails,
  MAX_FIELD_BYTES,
  nullLogger,
  safeText,
} from "../src/log";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    appendFileSync: vi.fn(actual.appendFileSync),
    renameSync: vi.fn(actual.renameSync),
    writeSync: vi.fn(actual.writeSync),
  };
});

const directories: string[] = [];
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "coordinator-log-"));
  directories.push(path);
  return path;
}
afterEach(async () => {
  vi.resetAllMocks();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("structured logging", () => {
  it("emits Python-compatible JSON, filters DEBUG, redacts secrets, caps every string", () => {
    const lines: string[] = [];
    const logger = createStructuredLogger({
      environment: { API_TOKEN: "known-secret" },
      write: (line) => lines.push(line),
    });
    logger.log("DEBUG", "hidden");
    logger.log("INFO", "hello known-secret Bearer abcdef", {
      model: "😀".repeat(10000),
      cost: 1.25,
    });
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0] ?? "");
    expect(record).toMatchObject({
      level: "INFO",
      logger: "coordinator",
      message: "hello [REDACTED] Bearer [REDACTED]",
      run_id: null,
      task_key: null,
      cost: 1.25,
    });
    expect(new Date(record.timestamp).toISOString()).toBe(record.timestamp);
    expect(Buffer.byteLength(record.model)).toBeLessThanOrEqual(MAX_FIELD_BYTES);
    expect(record.model).toContain("[TRUNCATED]");
    expect(record.model).not.toContain("�");
    const debug: string[] = [];
    createStructuredLogger({
      environment: { DEBUG: "true" },
      write: (line) => debug.push(line),
    }).log("DEBUG", "visible");
    expect(debug).toHaveLength(1);
  });

  it("bounds cyclic causal chains and ignores arbitrary error payloads", () => {
    const cause = new Error("missing Bearer abcdef");
    const error = new Error("outer", { cause });
    cause.cause = error;
    Object.assign(error, { request: { prompt: "private prompt" }, response: "private body" });
    const details = errorDetails(error);
    expect(details).toContain("Error: outer");
    expect(details).toContain("Caused by:");
    expect(details).toContain("[cyclic cause]");
    expect(details).not.toMatch(/abcdef|private/);
    expect(Buffer.byteLength(errorDetails(new Error("x".repeat(30000))))).toBeLessThanOrEqual(
      MAX_FIELD_BYTES,
    );
  });

  it("isolates concurrent scopes and restores context on rejection", async () => {
    const records: Record<string, unknown>[] = [];
    const logger = createStructuredLogger({ write: (line) => records.push(JSON.parse(line)) });
    await Promise.all(
      ["one", "two"].map((run_id) =>
        logger.scope({ run_id }, async () => {
          await new Promise((resolve) => setTimeout(resolve, run_id === "one" ? 5 : 0));
          logger.child({ attempt_id: `${run_id}-attempt` }).log("INFO", "inside");
        }),
      ),
    );
    await expect(
      logger.scope({ run_id: "failed" }, async () => {
        throw new Error("failed");
      }),
    ).rejects.toThrow();
    logger.log("INFO", "outside");
    expect(records.slice(0, 2)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ run_id: "one", attempt_id: "one-attempt" }),
        expect.objectContaining({ run_id: "two", attempt_id: "two-attempt" }),
      ]),
    );
    expect(records[2]?.run_id).toBeNull();
  });

  it("rotates bounded secure files and duplicates JSON to stdout sink", async () => {
    const path = await directory();
    const lines: string[] = [];
    const logger = createFileLogger({
      dataDirectory: path,
      maxBytes: 350,
      backupCount: 2,
      write: (line) => lines.push(line),
      environment: {},
    });
    for (let index = 0; index < 8; index++) logger.log("INFO", `record ${index}`);
    expect((await readdir(path)).sort()).toEqual(["bot.log", "bot.log.1", "bot.log.2"]);
    for (const file of await readdir(path)) {
      expect((await stat(join(path, file))).mode & 0o777).toBe(0o600);
      expect((await stat(join(path, file))).size).toBeLessThanOrEqual(350);
      for (const line of (await readFile(join(path, file), "utf8")).trim().split("\n"))
        JSON.parse(line);
    }
    expect(
      (await readFile(join(path, "bot.log"), "utf8")).endsWith(lines.at(-1) ?? "missing"),
    ).toBe(true);
  });

  it("keeps stdout and business errors intact when runtime appends fail with ENOSPC", async () => {
    const path = await directory();
    const stdout: string[] = [];
    const fallback: string[] = [];
    vi.mocked(writeSync).mockImplementation((fd, bytes) => {
      expect(fd).toBe(process.stderr.fd);
      fallback.push(String(bytes));
      return Buffer.byteLength(String(bytes));
    });
    const logger = createFileLogger({
      dataDirectory: path,
      environment: { API_TOKEN: "known-secret" },
      write: (line) => stdout.push(line),
    });
    logger.log("INFO", "Run started");
    const fullDisk = Object.assign(
      new Error(`ENOSPC known-secret Bearer abcdef ${"x".repeat(10000)}`),
      {
        code: "ENOSPC",
        request: { body: "private-body" },
      },
    );
    vi.mocked(appendFileSync).mockImplementationOnce(() => {
      throw fullDisk;
    });
    const original = new Error("original business error");
    await expect(
      logger.scope({ run_id: "run-full", attempt_id: "attempt-full" }, async () => {
        try {
          throw original;
        } finally {
          logger.log("ERROR", "Run failed");
        }
      }),
    ).rejects.toBe(original);
    expect(stdout.map((line) => JSON.parse(line).message)).toEqual(["Run started", "Run failed"]);
    expect(fallback).toHaveLength(1);
    const warning = JSON.parse(fallback[0] ?? "");
    expect(warning).toMatchObject({
      level: "WARNING",
      logger: "coordinator.logging",
      sink: "file",
      run_id: "run-full",
      attempt_id: "attempt-full",
    });
    expect(warning.exc_info).toContain("ENOSPC");
    expect(warning.exc_info).toContain("[REDACTED]");
    expect(Buffer.byteLength(warning.exc_info)).toBeLessThanOrEqual(MAX_FIELD_BYTES);
    expect(fallback.join("")).not.toMatch(/known-secret|abcdef|private-body/);
    logger.log("INFO", "Cleanup finished");
    expect(await readFile(join(path, "bot.log"), "utf8")).toContain("Cleanup finished");
  });

  it("isolates runtime rotation failures and warns once per continuous outage", async () => {
    const path = await directory();
    const stdout: string[] = [];
    const fallback: string[] = [];
    vi.mocked(writeSync).mockImplementation((_fd, bytes) => {
      fallback.push(String(bytes));
      return Buffer.byteLength(String(bytes));
    });
    const logger = createFileLogger({
      dataDirectory: path,
      maxBytes: 1,
      backupCount: 1,
      write: (line) => stdout.push(line),
      environment: {},
    });
    logger.log("INFO", "first");
    vi.mocked(renameSync).mockImplementation(() => {
      throw new Error("EACCES during rotation");
    });
    expect(() => logger.log("INFO", "second")).not.toThrow();
    expect(() => logger.log("INFO", "third")).not.toThrow();
    expect(stdout).toHaveLength(3);
    expect(fallback).toHaveLength(1);
    expect(JSON.parse(fallback[0] ?? "")).toMatchObject({
      sink: "file",
      exc_info: expect.stringContaining("EACCES"),
    });
    vi.mocked(renameSync).mockReset();
    logger.log("INFO", "recovered");
    vi.mocked(renameSync).mockImplementationOnce(() => {
      throw new Error("EACCES again");
    });
    logger.log("INFO", "failed again");
    expect(fallback).toHaveLength(2);
  });

  it("isolates throwing stdout callbacks in structured and file loggers", async () => {
    const fallback: string[] = [];
    vi.mocked(writeSync).mockImplementation((_fd, bytes) => {
      fallback.push(String(bytes));
      return Buffer.byteLength(String(bytes));
    });
    const write = vi.fn(() => {
      throw new Error("EPIPE Bearer stdout-secret");
    });
    const logger = createStructuredLogger({ write });
    expect(() => logger.log("INFO", "Run started")).not.toThrow();
    expect(() => logger.log("INFO", "Run terminal")).not.toThrow();
    expect(write).toHaveBeenCalledTimes(2);
    expect(fallback).toHaveLength(1);
    expect(JSON.parse(fallback[0] ?? "")).toMatchObject({ sink: "stdout", level: "WARNING" });
    expect(fallback[0]).not.toContain("stdout-secret");
    const path = await directory();
    const fileLogger = createFileLogger({ dataDirectory: path, write });
    expect(() => fileLogger.log("INFO", "Cleanup finished")).not.toThrow();
    expect(await readFile(join(path, "bot.log"), "utf8")).toContain("Cleanup finished");
    expect(JSON.parse(fallback[1] ?? "").sink).toBe("stdout");
  });

  it("contains default stdout descriptor failures and failed stderr fallbacks without recursion", () => {
    const failure = Object.assign(new Error("EPIPE"), { code: "EPIPE" });
    vi.mocked(writeSync).mockImplementation(() => {
      throw failure;
    });
    const logger = createStructuredLogger();
    expect(() => logger.log("INFO", "Run started")).not.toThrow();
    expect(writeSync).toHaveBeenCalledTimes(2); // stdout, then one direct stderr attempt
    expect(() => logger.log("INFO", "Cleanup finished")).not.toThrow();
    expect(writeSync).toHaveBeenCalledTimes(3); // stdout retry; stderr outage already reported
  });

  it("jails relative, absolute, and symlink log paths", async () => {
    const root = await directory();
    const outside = await directory();
    for (const value of ["../escape.log", join(outside, "escape.log")]) {
      expect(() =>
        createFileLogger({ dataDirectory: root, environment: { BOT_LOG_FILE: value } }),
      ).toThrow("path jail");
    }
    await symlink(outside, join(root, "escape"));
    expect(() =>
      createFileLogger({
        dataDirectory: root,
        environment: { BOT_LOG_FILE: "escape/nested/out.log" },
      }),
    ).toThrow("path jail");
    const logger = createFileLogger({
      dataDirectory: root,
      environment: { BOT_LOG_FILE: "logs/custom.log" },
      write: () => undefined,
    });
    logger.log("INFO", "inside");
    expect(await readFile(join(root, "logs/custom.log"), "utf8")).toContain("inside");
    await symlink(join(root, "logs/custom.log"), join(root, "bot.log"));
    expect(() => createFileLogger({ dataDirectory: root, environment: {} })).toThrow("unsafe log");
  });

  it("redacts patterned credentials before field caps", () => {
    const text = safeText(
      `https://user:password@example.invalid Bearer abcdef ghp_${"a".repeat(24)} sk-ant-${"z".repeat(30)} -----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----`,
    );
    expect(text).not.toMatch(/password|abcdef|aaaa|zzzz|\nsecret/);
    expect(safeText(`${"x".repeat(9000)}secret-value`, { SECRET: "secret-value" })).not.toContain(
      "secret-value",
    );
  });
});

describe("untrusted runtime diagnostics", () => {
  it.each(["ERROR", "FATAL", "WARN", "WARNING"])(
    "classifies timestamp-prefixed level=%s without forwarding unknown text",
    (level) => {
      const line = `timestamp=2026-10-16T09:40:00Z level=${level} run=run-1 message="stream error" error.error="AI_APICallError: private-canary-value"`;
      expect(classifyDiagnostic(line)).toBe(
        level.startsWith("WARN")
          ? "unclassified runtime warning (payload suppressed)"
          : "unclassified runtime error (payload suppressed)",
      );
    },
  );

  it("does not misclassify INFO or non-severity fields as runtime failures", () => {
    for (const line of [
      "timestamp=now level=INFO message=private-canary-value",
      "timestamp=now notlevel=ERROR",
      "timestamp=now level=ERROR_DETAIL",
    ]) {
      expect(classifyDiagnostic(line)).toBeUndefined();
    }
  });

  it("recognizes observed npm offline cache and install failures in causal metadata", () => {
    const error = {
      name: "InitError",
      data: {
        cause: {
          name: "NpmInstallFailedError",
          message: "cache mode is 'only-if-cached' but no cached response is available",
          request: { body: "private-request" },
        },
      },
    };
    const diagnostic = providerDiagnostic(error);
    expect(diagnostic).toContain("provider initialization failed");
    expect(diagnostic).toContain("offline package cache miss");
    expect(diagnostic).toContain("dependency install failed");
    expect(diagnostic).not.toContain("private-request");
  });

  it("extracts nested InitError causes without serializing payloads", () => {
    const error = {
      name: "InitError",
      data: {
        message: "Failed to initialize provider",
        cause: {
          name: "Error",
          message: "Cannot find package @ai-sdk/openai",
          code: "ERR_MODULE_NOT_FOUND",
          request: "private prompt",
          body: "private body",
        },
      },
    };
    Object.assign(error.data.cause, { cause: error });
    expect(providerDiagnostic(error)).toContain("provider initialization failed");
    expect(providerDiagnostic(error)).toContain("module not found");
    expect(providerDiagnostic(error)).not.toMatch(/private/);
    const failure = new Error("request private prompt", {
      cause: new Error("ENOTCACHED private body"),
    });
    expect(runtimeErrorDetails(failure)).toContain("offline package cache miss");
    expect(runtimeErrorDetails(failure)).toContain("at /");
    expect(runtimeErrorDetails(failure)).not.toMatch(/private/);
  });

  it("surfaces successful stderr with severity while bounding and suppressing raw payloads", async () => {
    const records: Record<string, unknown>[] = [];
    const logger = createStructuredLogger({ write: (line) => records.push(JSON.parse(line)) });
    const tail = await collectBridgeDiagnostics(
      Readable.from([
        '{"level":"INFO","logger":"third_party","message":"ENOT',
        'CACHED private prompt","request":"private body"}\n',
        "x".repeat(20000),
        "private-tail\n",
        ...Array.from({ length: 50 }, () => "ERROR ProviderInitError private tool args\n"),
      ]),
      logger,
      "preflight",
    );
    expect(records[0]).toMatchObject({
      level: "WARNING",
      source: "python",
      operation: "preflight",
      diagnostic: "offline package cache miss",
    });
    expect(records).toHaveLength(33);
    expect(records.at(-1)).toMatchObject({
      message: "Python bridge diagnostics suppressed",
      count: 20,
    });
    expect(JSON.stringify(records) + tail).not.toMatch(/private|xxxx/);
    expect(tail.length).toBeLessThanOrEqual(2048);
  });

  it("preserves trusted Python lifecycle/error messages, source and severity while omitting extras", async () => {
    const records: Record<string, unknown>[] = [];
    const logger = createStructuredLogger({
      environment: { DEBUG: "true" },
      write: (line) => records.push(JSON.parse(line)),
    });
    const inputs = [
      {
        logger: "bot.config",
        level: "INFO",
        message: "Instance config validated: workflow=jira-sprint, envs=['github']",
      },
      { logger: "bot.preflight", level: "INFO", message: "Preflight 01-test.py starting" },
      {
        logger: "bot.preflight",
        level: "INFO",
        message: "Preflight 01-test.py → skip (13 chars) in 0.02s",
      },
      {
        logger: "bot.config",
        level: "ERROR",
        message: "FATAL: Workflow preset 'missing' not found at /work/presets/workflows/missing",
      },
      {
        logger: "bot.run",
        level: "WARNING",
        message: "Config repo sync failed: known-secret Bearer abcdef — using built-in config",
      },
      {
        logger: "bot.preflight",
        level: "DEBUG",
        message: "No preflight scripts found — pass-through",
      },
      {
        logger: "bot.coordinator_bridge",
        level: "CRITICAL",
        message: "coordinator bridge failed: unsupported protocolVersion",
      },
    ];
    await collectBridgeDiagnostics(
      Readable.from(
        inputs.map(
          (entry) =>
            `${JSON.stringify({
              ...entry,
              request: { prompt: "private-prompt" },
              response: { body: "private-body" },
              tool: { args: "private-tool" },
              exc_info: "private-trace",
              run_id: "forged-run",
              extra: "private-extra",
            })}\n`,
        ),
      ),
      logger,
      "preflight",
      { BRIDGE_TOKEN: "known-secret" },
    );
    expect(records).toHaveLength(inputs.length);
    for (const [index, input] of inputs.entries()) {
      expect(records[index]).toMatchObject({
        logger: input.logger,
        source: input.logger,
        level: input.level,
        message: safeText(input.message, { BRIDGE_TOKEN: "known-secret" }),
        operation: "preflight",
        run_id: null,
      });
      expect(records[index]).not.toHaveProperty("diagnostic");
    }
    expect(JSON.stringify(records)).not.toMatch(/private-|known-secret|abcdef|forged-run/);
  });

  it("bounds trusted string fields before passing to an injected logger; rejects malformed or unknown records", async () => {
    const records: Record<string, unknown>[] = [];
    await collectBridgeDiagnostics(
      Readable.from([
        `${JSON.stringify({ logger: "bot.preflight", level: "INFO", message: "x".repeat(10000) })}\n`,
        ...[
          { logger: "bot.unrecognized", level: "INFO", message: "private-unknown" },
          { logger: "bot.preflight", level: "INVALID", message: "private-invalid" },
          { logger: "bot.preflight", level: "ERROR", message: { request: "private-object" } },
          { logger: "bot.preflight", level: "INFO" },
        ].map((entry) => `${JSON.stringify(entry)}\n`),
      ]),
      {
        ...nullLogger,
        log: (level, message, fields) => records.push({ level, message, ...fields }),
      },
      "preflight",
    );
    expect(Buffer.byteLength(String(records[0]?.message))).toBeLessThanOrEqual(MAX_FIELD_BYTES);
    expect(records[0]?.message).toContain("[TRUNCATED]");
    expect(records.slice(1)).toHaveLength(4);
    for (const record of records.slice(1))
      expect(record).toMatchObject({
        message: "Python bridge diagnostic",
        source: "python",
        level: "WARNING",
      });
    expect(JSON.stringify(records)).not.toContain("private-");
  });

  it("forwards successful process stderr without corrupting the JSON stdout envelope", async () => {
    const path = await directory();
    const executable = join(path, "bridge");
    await writeFile(
      executable,
      `#!/usr/bin/env node\nprocess.stdin.resume();\nprocess.stdin.on('end', () => { process.stderr.write(JSON.stringify({level:'INFO',logger:'bot.preflight',message:'Preflight 01-test.py starting',request:{prompt:'private prompt'}})+'\\n'); process.stdout.write(JSON.stringify({protocolVersion:1,ok:true,result:null})); });\n`,
      { mode: 0o700 },
    );
    const records: unknown[] = [];
    const bridge = new PythonCoordinatorBridge({
      executable,
      logger: createStructuredLogger({ write: (line) => records.push(JSON.parse(line)) }),
    });
    expect(await bridge.preflight({ scriptDir: path, workflow: "test" })).toBeNull();
    expect(records).toContainEqual(
      expect.objectContaining({
        level: "INFO",
        logger: "bot.preflight",
        message: "Preflight 01-test.py starting",
      }),
    );
    expect(JSON.stringify(records)).not.toContain("private prompt");
  });

  it("preserves useful own bridge failure messages in diagnostics and thrown errors", async () => {
    const path = await directory();
    const executable = join(path, "bridge");
    const message =
      "coordinator bridge failed: validate_instance_config failed (see bridge stderr for details)";
    await writeFile(
      executable,
      `#!/usr/bin/env node\nprocess.stdin.resume();\nprocess.stdin.on('end', () => { process.stderr.write(JSON.stringify({level:'ERROR',logger:'bot.coordinator_bridge',message:${JSON.stringify(message)},request:{body:'private-body'}})+'\\n'); process.exitCode=2; });\n`,
      { mode: 0o700 },
    );
    const records: Record<string, unknown>[] = [];
    const bridge = new PythonCoordinatorBridge({
      executable,
      logger: createStructuredLogger({ write: (line) => records.push(JSON.parse(line)) }),
    });
    const error = await bridge
      .preflight({ scriptDir: path, workflow: "test" })
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(message);
    expect((error as Error).message).not.toContain("private-body");
    expect(records).toContainEqual(
      expect.objectContaining({ level: "ERROR", logger: "bot.coordinator_bridge", message }),
    );
    expect(JSON.stringify(records)).not.toContain("private-body");
  });
});

import { appendFileSync, renameSync, writeSync } from "node:fs";
