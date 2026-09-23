import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { isAbsolute, relative } from "node:path";

import {
  abortReason,
  assertPositiveInteger,
  boundedOperation,
  redactSensitiveText,
  stableJson,
} from "../shared";

import {
  buildOpenCodeEnvironment,
  createOpenCodeFetch,
  type OpenCodeEnvironmentOptions,
  type OpenCodeFetch,
} from "./environment";

export const OPENCODE_VERSION = "1.18.29" as const;
const STARTUP_OUTPUT_LIMIT = 16_384;
const STARTUP_DIAGNOSTIC_LIMIT = 2_048;

/** Capabilities provided by the pinned server/SDK protocol, not /global/health. */
export const OPENCODE_V1_CAPABILITIES = ["sse", "sessions"] as const;

export interface OpenCodeHealth {
  healthy: boolean;
  version: string;
  capabilities?: readonly string[];
}

export interface OpenCodeReadiness {
  check(baseUrl: string, directory: string, signal: AbortSignal): Promise<OpenCodeHealth>;
}

export interface OpenCodeServerInfo extends OpenCodeHealth {
  baseUrl: string;
  hostname: string;
  port: number;
  /** Canonical, validated worktree path used for child cwd and client requests. */
  directory: string;
  configHash?: string;
}

export interface OpenCodeSupervisorOptions extends OpenCodeEnvironmentOptions {
  command?: string;
  hostname?: string;
  port?: number;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  expectedVersion?: string | RegExp;
  /** Required when config is supplied; must come from trusted policy data. */
  expectedConfigHash?: string;
  /** Required by start; absolute root containing only approved worktrees. */
  workspaceRoot?: string;
  /** Expected owner UID for the canonical worktree directory. */
  workspaceOwnerUid?: number;
  requiredCapabilities?: readonly string[];
  /** Probe the process group belonging to the child PID. */
  processGroupExists?: (pid: number) => boolean;
  /** Bound verification after SIGKILL when a group ignores the grace signal. */
  killVerificationTimeoutMs?: number;
  config?: Record<string, unknown>;
  readiness?: OpenCodeReadiness;
  /** Trusted direct-loopback transport override for readiness checks. */
  fetch?: OpenCodeFetch;
  spawnProcess?: OpenCodeSpawn;
  signalProcess?: OpenCodeSignalProcess;
  allocatePort?: () => Promise<number>;
}

export type OpenCodeSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export type OpenCodeSignalProcess = (pid: number, signal: NodeJS.Signals) => void;

type RequiredOpenCodeSupervisorOption =
  | "command"
  | "hostname"
  | "startupTimeoutMs"
  | "shutdownTimeoutMs"
  | "killVerificationTimeoutMs";

export class OpenCodeReadinessError extends Error {
  constructor(
    message: string,
    readonly deterministic = false,
  ) {
    super(message);
    this.name = "OpenCodeReadinessError";
  }
}

export interface OpenCodeServerController {
  readonly info: OpenCodeServerInfo | undefined;
  readonly crashError: Error | undefined;
  readonly crashSignal: AbortSignal;
  start(directory: string, signal: AbortSignal): Promise<OpenCodeServerInfo>;
  stop(): Promise<void>;
}

export class OpenCodeServerSupervisor implements OpenCodeServerController {
  private readonly options: Required<
    Pick<OpenCodeSupervisorOptions, RequiredOpenCodeSupervisorOption>
  > &
    OpenCodeSupervisorOptions;
  private child?: ChildProcess;
  private server?: OpenCodeServerInfo;
  private stopping = false;
  private stopPromise?: Promise<void>;
  private exited = false;
  private termSent = false;
  private _crashError?: Error;
  private crashController = new AbortController();
  private outputCleanup?: () => void;
  private startupOutput = "";
  private startupOutputTruncated = false;

  constructor(options: OpenCodeSupervisorOptions = {}) {
    this.options = {
      ...options,
      command: options.command ?? "/usr/local/bin/opencode",
      hostname: options.hostname ?? "127.0.0.1",
      startupTimeoutMs: options.startupTimeoutMs ?? 10_000,
      shutdownTimeoutMs: options.shutdownTimeoutMs ?? 5_000,
      expectedVersion: options.expectedVersion ?? OPENCODE_VERSION,
      killVerificationTimeoutMs:
        options.killVerificationTimeoutMs ?? Math.min(options.shutdownTimeoutMs ?? 5_000, 1_000),
    };
    assertConfiguredBinary(this.options.command);
    assertApprovedHostname(this.options.hostname);
    assertPositiveInteger(this.options.startupTimeoutMs, "startupTimeoutMs", "OpenCode");
    assertPositiveInteger(this.options.shutdownTimeoutMs, "shutdownTimeoutMs", "OpenCode");
    assertPositiveInteger(
      this.options.killVerificationTimeoutMs,
      "killVerificationTimeoutMs",
      "OpenCode",
    );
  }

  get info(): OpenCodeServerInfo | undefined {
    return this.server;
  }

  get crashError(): Error | undefined {
    return this._crashError;
  }

  get crashSignal(): AbortSignal {
    return this.crashController.signal;
  }

  async start(directory: string, signal: AbortSignal): Promise<OpenCodeServerInfo> {
    if (this.child || this.server) throw new Error("OpenCode server already started");
    if (signal.aborted) throw abortReason(signal);

    const workspaceDirectory = await resolveApprovedWorkspace(
      directory,
      this.options.workspaceRoot,
      this.options.workspaceOwnerUid,
    );
    if (signal.aborted) throw abortReason(signal);

    const configHash = this.options.config ? hashOpenCodeConfig(this.options.config) : undefined;
    if (this.options.config && !this.options.expectedConfigHash) {
      throw new OpenCodeReadinessError(
        "OpenCode expected config hash is required when config is provided",
        true,
      );
    }
    if (this.options.expectedConfigHash && configHash !== this.options.expectedConfigHash) {
      throw new OpenCodeReadinessError(
        `OpenCode config hash ${configHash ?? "missing"} does not match expected ${this.options.expectedConfigHash}`,
      );
    }

    const allocatePortFn = this.options.allocatePort ?? allocatePort;
    const port = this.options.port ?? (await allocatePortFn());
    const environment = buildOpenCodeEnvironment(this.options);
    if (this.options.config) {
      environment.OPENCODE_CONFIG_CONTENT = stableJson(this.options.config);
    }
    const args = ["serve", `--hostname=${this.options.hostname}`, `--port=${port}`];
    const spawnProcess = this.options.spawnProcess ?? defaultSpawn;
    this.startupOutput = "";
    this.startupOutputTruncated = false;
    const child = spawnProcess(this.options.command, args, {
      cwd: workspaceDirectory,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    this.child = child;
    this.exited = false;
    this.termSent = false;
    this._crashError = undefined;
    this.crashController = new AbortController();

    const exitPromise = this.observeExit(child);
    const startupSignal = AbortSignal.any([signal, this.crashSignal]);
    const startupDeadline = Date.now() + this.options.startupTimeoutMs;
    try {
      const baseUrl = await this.waitForListening(child, startupSignal, port, startupDeadline);
      const health = await this.waitForReadiness(
        baseUrl,
        workspaceDirectory,
        startupSignal,
        startupDeadline,
      );
      const missingCapabilities = (this.options.requiredCapabilities ?? []).filter(
        (capability) => !(OPENCODE_V1_CAPABILITIES as readonly string[]).includes(capability),
      );
      if (missingCapabilities.length > 0) {
        throw new OpenCodeReadinessError(
          `OpenCode readiness missing capabilities: ${missingCapabilities.join(", ")}`,
        );
      }
      const parsed = new URL(baseUrl);
      this.server = {
        ...health,
        baseUrl: baseUrl.replace(/\/$/, ""),
        hostname: parsed.hostname,
        port: Number(parsed.port),
        directory: workspaceDirectory,
        ...(configHash ? { configHash } : {}),
      };
      return this.server;
    } catch (error) {
      const startupError = this.withStartupOutput(error);
      await this.stop();
      throw startupError;
    } finally {
      // Keep exitPromise referenced so a rejected child-exit observation cannot
      // become an unhandled rejection after startup has already failed.
      void exitPromise.catch(() => undefined);
    }
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    const promise = this.stopInternal();
    this.stopPromise = promise;
    try {
      await promise;
    } finally {
      if (this.stopPromise === promise) this.stopPromise = undefined;
    }
  }

  private async stopInternal(): Promise<void> {
    if (!this.child) {
      this.outputCleanup?.();
      this.server = undefined;
      return;
    }
    if (this.stopping) return;

    this.stopping = true;
    const child = this.child;
    try {
      const groupExists = (): boolean => this.processGroupExists(child);
      if (!this.exited || (groupExists() && !this.termSent)) {
        this.signalChild(child, "SIGTERM");
      }
      await waitForExit(
        child,
        this.options.shutdownTimeoutMs,
        () => this.signalChild(child, "SIGKILL"),
        this.exited,
        groupExists,
        this.options.killVerificationTimeoutMs,
      );
    } finally {
      this.outputCleanup?.();
      this.child = undefined;
      this.server = undefined;
      this.stopping = false;
    }
  }

  private signalChild(child: ChildProcess, signal: NodeJS.Signals): void {
    if (signal === "SIGTERM") this.termSent = true;
    signalProcessTree(child, signal, this.options.signalProcess);
  }

  private processGroupExists(child: ChildProcess): boolean {
    if (process.platform === "win32" || !child.pid) return false;
    return (this.options.processGroupExists ?? defaultProcessGroupExists)(child.pid);
  }

  private observeExit(child: ChildProcess): Promise<void> {
    return new Promise((resolve, reject) => {
      const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        this.exited = true;
        if (!this.stopping && !this._crashError) {
          const error = new Error(
            this.server
              ? `OpenCode server crashed after startup (code=${code ?? "null"}, signal=${signal ?? "none"})`
              : `OpenCode server exited before readiness (code=${code ?? "null"}, signal=${signal ?? "none"})`,
          );
          this._crashError = this.server ? error : this.withStartupOutput(error);
          this.crashController.abort(this._crashError);
          this.signalChild(child, "SIGTERM");
        }
        resolve();
      };
      const onError = (error: Error): void => {
        this.exited = true;
        const safeError = redactError(error);
        if (!this.stopping) {
          this._crashError = this.server ? safeError : this.withStartupOutput(safeError);
          this.crashController.abort(this._crashError);
          this.signalChild(child, "SIGTERM");
        }
        reject(this._crashError ?? safeError);
      };
      child.once("exit", onExit);
      child.once("error", onError);
    });
  }

  private withStartupOutput(value: unknown): Error {
    const error = value instanceof Error ? value : new Error(String(value));
    const diagnostic = this.startupDiagnostic();
    if (diagnostic && !error.message.includes("OpenCode startup output (tail)")) {
      error.message = `${error.message}\nOpenCode startup output (tail):\n${diagnostic}`;
    }
    error.message = redactSensitiveText(error.message);
    return error;
  }

  private startupDiagnostic(): string {
    let output = this.startupOutput;
    if (this.startupOutputTruncated) {
      const firstLineEnd = output.indexOf("\n");
      if (firstLineEnd === -1) return "";
      output = output.slice(firstLineEnd + 1);
    }
    return redactSensitiveText(output).slice(-STARTUP_DIAGNOSTIC_LIMIT);
  }

  private waitForListening(
    child: ChildProcess,
    signal: AbortSignal,
    expectedPort: number,
    deadline: number,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      let settled = false;

      const cleanup = (): void => {
        if (timer) clearTimeout(timer);
        child.removeListener("exit", onExit);
        child.removeListener("error", onError);
        signal.removeEventListener("abort", onAbort);
      };
      const finish = (error?: Error, url?: string): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve(url as string);
      };
      const onData = (chunk: Buffer | string): void => {
        if (settled) return;
        const text = chunk.toString();
        if (this.startupOutput.length + text.length > STARTUP_OUTPUT_LIMIT) {
          this.startupOutputTruncated = true;
        }
        this.startupOutput = appendBoundedOpenCodeOutput(this.startupOutput, text);
        for (const line of this.startupOutput.split(/\r?\n/)) {
          const match = line.match(/server listening on (https?:\/\/[^\s]+)/i);
          if (match) {
            try {
              const url = new URL(match[1]);
              if (url.protocol !== "http:") {
                finish(
                  new OpenCodeReadinessError(
                    `OpenCode server advertised unapproved protocol ${url.protocol}`,
                  ),
                );
                return;
              }
              if (url.hostname !== this.options.hostname) {
                finish(
                  new OpenCodeReadinessError(
                    `OpenCode server advertised unapproved host ${url.hostname}`,
                  ),
                );
                return;
              }
              if (url.port !== String(expectedPort)) {
                finish(
                  new OpenCodeReadinessError(
                    `OpenCode server advertised unapproved port ${url.port || "default"}; expected ${expectedPort}`,
                  ),
                );
                return;
              }
              finish(undefined, url.toString().replace(/\/$/, ""));
              return;
            } catch {
              finish(new OpenCodeReadinessError("OpenCode server advertised an invalid URL"));
              return;
            }
          }
        }
      };
      const onExit = (code: number | null, signalName: NodeJS.Signals | null): void => {
        finish(
          this.withStartupOutput(
            new Error(
              `OpenCode server exited before readiness (code=${code ?? "null"}, signal=${signalName ?? "none"})`,
            ),
          ),
        );
      };
      const onError = (error: Error): void => finish(error);
      const onAbort = (): void => finish(abortReason(signal));
      const removeOutput = (): void => {
        child.stdout?.removeListener("data", onData);
        child.stderr?.removeListener("data", onData);
        if (this.outputCleanup === removeOutput) this.outputCleanup = undefined;
      };
      this.outputCleanup = removeOutput;

      timer = setTimeout(
        () =>
          finish(
            this.withStartupOutput(
              new OpenCodeReadinessError(
                `Timed out waiting for OpenCode server readiness after ${this.options.startupTimeoutMs}ms`,
              ),
            ),
          ),
        Math.max(0, deadline - Date.now()),
      );
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      child.once("exit", onExit);
      child.once("error", onError);
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private async waitForReadiness(
    baseUrl: string,
    directory: string,
    signal: AbortSignal,
    deadline: number,
  ): Promise<OpenCodeHealth> {
    const readiness = this.options.readiness ?? new HttpOpenCodeReadiness(this.options.fetch);
    let lastError: unknown;

    while (Date.now() < deadline) {
      if (signal.aborted) throw abortReason(signal);
      try {
        const health = await boundedOperation(
          (requestSignal) => readiness.check(baseUrl, directory, requestSignal),
          signal,
          deadline,
          "OpenCode readiness",
          new OpenCodeReadinessError("OpenCode readiness deadline exceeded"),
        );
        if (
          this.options.expectedVersion &&
          !matchesVersion(health.version, this.options.expectedVersion)
        ) {
          throw new OpenCodeReadinessError(
            `OpenCode version ${health.version} does not satisfy expected version ${String(this.options.expectedVersion)}`,
            true,
          );
        }
        return health;
      } catch (error) {
        if (error instanceof OpenCodeReadinessError && error.deterministic) throw error;
        lastError = error;
        if (Date.now() < deadline) await delay(50, signal);
      }
    }

    const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
    throw new OpenCodeReadinessError(
      `OpenCode readiness failed for ${baseUrl}; verify client proxy/NO_PROXY configuration${detail}`,
    );
  }
}

function redactError(error: Error): Error {
  error.message = redactSensitiveText(error.message);
  return error;
}

/** Keeps startup diagnostics bounded while waiting for the advertised URL. */
export function appendBoundedOpenCodeOutput(output: string, chunk: Buffer | string): string {
  return `${output}${chunk.toString()}`.slice(-STARTUP_OUTPUT_LIMIT);
}

export class HttpOpenCodeReadiness implements OpenCodeReadiness {
  private readonly fetchImpl: OpenCodeFetch;

  constructor(fetchImpl?: OpenCodeFetch) {
    this.fetchImpl = createOpenCodeFetch(fetchImpl);
  }

  async check(baseUrl: string, directory: string, signal: AbortSignal): Promise<OpenCodeHealth> {
    const healthResponse = await this.fetchImpl(`${baseUrl}/global/health`, { signal });
    if (!healthResponse.ok) {
      throw new OpenCodeReadinessError(
        `OpenCode health returned HTTP ${healthResponse.status} at ${baseUrl}/global/health`,
      );
    }
    const health = await readJson(healthResponse, "health");
    if (
      health.healthy !== true ||
      typeof health.version !== "string" ||
      health.version.length === 0
    ) {
      throw new OpenCodeReadinessError(
        "OpenCode health response must contain healthy=true and version",
      );
    }

    const pathUrl = new URL(`${baseUrl}/path`);
    pathUrl.searchParams.set("directory", directory);
    const pathResponse = await this.fetchImpl(pathUrl, { signal });
    if (!pathResponse.ok) {
      throw new OpenCodeReadinessError(
        `OpenCode path check returned HTTP ${pathResponse.status} at ${pathUrl}`,
      );
    }
    const path = await readJson(pathResponse, "path");
    if (typeof path.directory !== "string") {
      throw new OpenCodeReadinessError(
        `OpenCode path check resolved ${String(path.directory)} instead of ${directory}`,
        true,
      );
    }
    const [expectedDirectory, actualDirectory] = await Promise.all([
      realpathOrOriginal(directory),
      realpathOrOriginal(path.directory),
    ]);
    if (actualDirectory !== expectedDirectory) {
      throw new OpenCodeReadinessError(
        `OpenCode path check resolved ${path.directory} instead of ${directory}`,
        true,
      );
    }

    const capabilities = parseCapabilities(health.capabilities);
    return {
      healthy: true,
      version: health.version,
      ...(capabilities ? { capabilities } : {}),
    };
  }
}

async function resolveApprovedWorkspace(
  directory: string,
  workspaceRoot: string | undefined,
  workspaceOwnerUid: number | undefined,
): Promise<string> {
  if (!isAbsolute(directory)) {
    throw new OpenCodeReadinessError(
      `OpenCode worktree path must be absolute, got ${directory}`,
      true,
    );
  }
  if (!workspaceRoot) {
    throw new OpenCodeReadinessError("OpenCode workspace root is required", true);
  }
  if (!isAbsolute(workspaceRoot)) {
    throw new OpenCodeReadinessError(
      `OpenCode workspace root must be absolute, got ${workspaceRoot}`,
      true,
    );
  }

  let canonicalRoot: string;
  let canonicalDirectory: string;
  try {
    [canonicalRoot, canonicalDirectory] = await Promise.all([
      realpath(workspaceRoot),
      realpath(directory),
    ]);
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new OpenCodeReadinessError(
      `OpenCode worktree path must resolve to an accessible directory${detail}`,
      true,
    );
  }

  const relativeDirectory = relative(canonicalRoot, canonicalDirectory);
  if (
    relativeDirectory !== "" &&
    (relativeDirectory === ".." ||
      relativeDirectory.startsWith(`..${pathSeparator()}`) ||
      isAbsolute(relativeDirectory))
  ) {
    throw new OpenCodeReadinessError(
      `OpenCode worktree path ${canonicalDirectory} is outside approved workspace root ${canonicalRoot}`,
      true,
    );
  }

  let directoryStats: Awaited<ReturnType<typeof stat>>;
  try {
    directoryStats = await stat(canonicalDirectory);
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new OpenCodeReadinessError(`OpenCode worktree path must be stat-able${detail}`, true);
  }
  if (!directoryStats.isDirectory()) {
    throw new OpenCodeReadinessError(
      `OpenCode worktree path is not a directory: ${canonicalDirectory}`,
      true,
    );
  }

  const expectedOwnerUid = workspaceOwnerUid ?? currentUserUid();
  if (expectedOwnerUid !== undefined && directoryStats.uid !== expectedOwnerUid) {
    throw new OpenCodeReadinessError(
      `OpenCode worktree path ${canonicalDirectory} is owned by UID ${directoryStats.uid}, expected ${expectedOwnerUid}`,
      true,
    );
  }
  return canonicalDirectory;
}

function currentUserUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function pathSeparator(): string {
  return process.platform === "win32" ? "\\" : "/";
}

function defaultSpawn(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
): ChildProcess {
  return spawn(command, [...args], options);
}

async function allocatePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!address || typeof address === "string") throw new Error("failed to allocate OpenCode port");
  return address.port;
}

function assertConfiguredBinary(command: string): void {
  if (!isAbsolute(command)) {
    throw new Error(`OpenCode binary path must be absolute, got ${command}`);
  }
}

function assertApprovedHostname(hostname: string): void {
  if (hostname !== "127.0.0.1" && hostname !== "localhost") {
    throw new Error(`OpenCode server hostname must be loopback, got ${hostname}`);
  }
}

function signalProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals,
  injectedSignal?: OpenCodeSignalProcess,
): void {
  if (child.pid && process.platform !== "win32") {
    try {
      const signalProcessFn = injectedSignal ?? signalProcess;
      signalProcessFn(-child.pid, signal);
      return;
    } catch (error) {
      if (!isNoSuchProcess(error)) throw error;
    }
  }
  child.kill(signal);
}

function signalProcess(pid: number, signal: NodeJS.Signals): void {
  process.kill(pid, signal);
}

function defaultProcessGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (isNoSuchProcess(error)) return false;
    if (isPermissionDenied(error)) return true;
    throw error;
  }
}

function isPermissionDenied(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
}

function isNoSuchProcess(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH";
}

export function hashOpenCodeConfig(config: Record<string, unknown>): string {
  return createHash("sha256").update(stableJson(config)).digest("hex");
}

function parseCapabilities(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new OpenCodeReadinessError("OpenCode health capabilities must be an array of strings");
  }
  return value;
}

function matchesVersion(version: string, expected: string | RegExp): boolean {
  if (typeof expected === "string") return version === expected;
  expected.lastIndex = 0;
  return expected.test(version);
}

async function realpathOrOriginal(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

async function readJson(response: Response, name: string): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new OpenCodeReadinessError(`OpenCode ${name} response was not JSON`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new OpenCodeReadinessError(`OpenCode ${name} response was not an object`);
  }
  return value as Record<string, unknown>;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function waitForExit(
  child: ChildProcess,
  timeoutMs: number,
  onTimeout: () => void,
  alreadyExited = false,
  processGroupExists: () => boolean = () => false,
  killVerificationTimeoutMs = timeoutMs,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let leaderExited = alreadyExited;
    let graceTimer: NodeJS.Timeout | undefined;
    let verificationTimer: NodeJS.Timeout | undefined;
    let pollTimer: NodeJS.Timeout | undefined;

    const cleanup = (): void => {
      if (graceTimer) clearTimeout(graceTimer);
      if (verificationTimer) clearTimeout(verificationTimer);
      if (pollTimer) clearInterval(pollTimer);
      child.removeListener("close", onExit);
      child.removeListener("exit", onExit);
      child.removeListener("error", onError);
    };
    const finish = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const groupGone = (): boolean => leaderExited && !processGroupExists();
    const check = (): void => {
      if (settled) return;
      try {
        if (groupGone()) finish();
      } catch (error) {
        fail(error);
      }
    };
    const onExit = (): void => {
      leaderExited = true;
      check();
    };
    const onError = (error: Error): void => {
      leaderExited = true;
      // An error means the leader cannot be waited on. Descendants still get
      // the same group grace period and liveness check.
      check();
      if (settled) return;
      try {
        if (!processGroupExists()) fail(error);
      } catch (probeError) {
        fail(probeError);
      }
    };
    const forceKill = (): void => {
      if (settled) return;
      try {
        onTimeout();
        check();
      } catch (error) {
        fail(error);
        return;
      }
      if (settled) return;
      verificationTimer = setTimeout(() => {
        check();
        if (!settled) {
          fail(new Error("OpenCode process group remained alive after SIGKILL"));
        }
      }, killVerificationTimeoutMs);
    };

    if (!alreadyExited) {
      child.once("close", onExit);
      child.once("exit", onExit);
      child.once("error", onError);
    }
    pollTimer = setInterval(check, 10);
    graceTimer = setTimeout(forceKill, timeoutMs);
    check();
  });
}
