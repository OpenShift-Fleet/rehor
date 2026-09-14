import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { isAbsolute } from "node:path";

import { buildOpenCodeEnvironment, type OpenCodeEnvironmentOptions } from "./environment";

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
  configHash?: string;
}

export interface OpenCodeSupervisorOptions extends OpenCodeEnvironmentOptions {
  command?: string;
  hostname?: string;
  port?: number;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  expectedVersion?: string | RegExp;
  expectedConfigHash?: string;
  requiredCapabilities?: readonly string[];
  config?: Record<string, unknown>;
  readiness?: OpenCodeReadiness;
  fetch?: typeof fetch;
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
  | "shutdownTimeoutMs";

export class OpenCodeReadinessError extends Error {
  constructor(message: string) {
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
  private _crashError?: Error;
  private crashController = new AbortController();
  private outputCleanup?: () => void;

  constructor(options: OpenCodeSupervisorOptions = {}) {
    this.options = {
      ...options,
      command: options.command ?? "/usr/local/bin/opencode",
      hostname: options.hostname ?? "127.0.0.1",
      startupTimeoutMs: options.startupTimeoutMs ?? 10_000,
      shutdownTimeoutMs: options.shutdownTimeoutMs ?? 5_000,
    };
    assertConfiguredBinary(this.options.command);
    assertApprovedHostname(this.options.hostname);
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

    const configHash = this.options.config ? hashOpenCodeConfig(this.options.config) : undefined;
    if (this.options.expectedConfigHash && configHash !== this.options.expectedConfigHash) {
      throw new OpenCodeReadinessError(
        `OpenCode config hash ${configHash ?? "missing"} does not match expected ${this.options.expectedConfigHash}`,
      );
    }

    const allocatePortFn = this.options.allocatePort ?? allocatePort;
    const port = this.options.port ?? (await allocatePortFn());
    const environment = buildOpenCodeEnvironment({
      ...this.options,
      base: this.options.config
        ? {
            ...(this.options.base ?? process.env),
            OPENCODE_CONFIG_CONTENT: stableJson(this.options.config),
          }
        : this.options.base,
    });
    const args = ["serve", `--hostname=${this.options.hostname}`, `--port=${port}`];
    const spawnProcess = this.options.spawnProcess ?? defaultSpawn;
    const child = spawnProcess(this.options.command, args, {
      cwd: directory,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    this.child = child;
    this.exited = false;
    this._crashError = undefined;
    this.crashController = new AbortController();

    const exitPromise = this.observeExit(child);
    const startupSignal = AbortSignal.any([signal, this.crashSignal]);
    try {
      const baseUrl = await this.waitForListening(child, startupSignal);
      const health = await this.waitForReadiness(baseUrl, directory, startupSignal);
      const missingCapabilities = (this.options.requiredCapabilities ?? []).filter(
        (capability) => !health.capabilities?.includes(capability),
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
        ...(configHash ? { configHash } : {}),
      };
      return this.server;
    } catch (error) {
      await this.stop();
      throw error;
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
      const exitPromise = waitForExit(child, this.options.shutdownTimeoutMs, () => {
        this.signalChild(child, "SIGKILL");
      });
      if (!this.exited || this._crashError) this.signalChild(child, "SIGTERM");
      await exitPromise;
    } finally {
      this.outputCleanup?.();
      this.child = undefined;
      this.server = undefined;
      this.stopping = false;
    }
  }

  private signalChild(child: ChildProcess, signal: NodeJS.Signals): void {
    signalProcessTree(child, signal, this.options.signalProcess);
  }

  private observeExit(child: ChildProcess): Promise<void> {
    return new Promise((resolve, reject) => {
      const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        this.exited = true;
        if (!this.stopping && !this._crashError) {
          this._crashError = new Error(
            `OpenCode server exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "none"})`,
          );
          this.crashController.abort(this._crashError);
          this.signalChild(child, "SIGTERM");
        }
        resolve();
      };
      const onError = (error: Error): void => {
        this.exited = true;
        if (!this.stopping) {
          this._crashError = error;
          this.crashController.abort(error);
          this.signalChild(child, "SIGTERM");
        }
        reject(error);
      };
      child.once("exit", onExit);
      child.once("error", onError);
    });
  }

  private waitForListening(child: ChildProcess, signal: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      let output = "";
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
        output = appendBoundedOpenCodeOutput(output, chunk);
        for (const line of output.split(/\r?\n/)) {
          const match = line.match(/server listening on (https?:\/\/[^\s]+)/i);
          if (match) {
            try {
              const url = new URL(match[1]);
              if (url.hostname !== this.options.hostname) {
                finish(
                  new OpenCodeReadinessError(
                    `OpenCode server advertised unapproved host ${url.hostname}`,
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
          new Error(
            `OpenCode server exited before readiness (code=${code ?? "null"}, signal=${signalName ?? "none"})`,
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
            new OpenCodeReadinessError(
              `Timed out waiting for OpenCode server readiness after ${this.options.startupTimeoutMs}ms`,
            ),
          ),
        this.options.startupTimeoutMs,
      );
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      child.once("exit", onExit);
      child.once("error", onError);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private async waitForReadiness(
    baseUrl: string,
    directory: string,
    signal: AbortSignal,
  ): Promise<OpenCodeHealth> {
    const readiness = this.options.readiness ?? new HttpOpenCodeReadiness(this.options.fetch);
    const deadline = Date.now() + this.options.startupTimeoutMs;
    let lastError: unknown;

    while (Date.now() < deadline) {
      if (signal.aborted) throw abortReason(signal);
      try {
        const health = await readiness.check(baseUrl, directory, signal);
        if (
          this.options.expectedVersion &&
          !matchesVersion(health.version, this.options.expectedVersion)
        ) {
          throw new OpenCodeReadinessError(
            `OpenCode version ${health.version} does not satisfy expected version ${String(this.options.expectedVersion)}`,
          );
        }
        return health;
      } catch (error) {
        lastError = error;
        await delay(50, signal);
      }
    }

    const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
    throw new OpenCodeReadinessError(
      `OpenCode readiness failed for ${baseUrl}; verify client proxy/NO_PROXY configuration${detail}`,
    );
  }
}

/** Keeps startup diagnostics bounded while waiting for the advertised URL. */
export function appendBoundedOpenCodeOutput(output: string, chunk: Buffer | string): string {
  return `${output}${chunk.toString()}`.slice(-16_384);
}

export class HttpOpenCodeReadiness implements OpenCodeReadiness {
  constructor(private readonly fetchImpl: typeof fetch = globalThis.fetch) {}

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
    if (path.directory !== directory) {
      throw new OpenCodeReadinessError(
        `OpenCode path check resolved ${String(path.directory)} instead of ${directory}`,
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

function isNoSuchProcess(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH";
}

export function hashOpenCodeConfig(config: Record<string, unknown>): string {
  return createHash("sha256").update(stableJson(config)).digest("hex");
}

function stableJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(",")}}`;
}

function parseCapabilities(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new OpenCodeReadinessError("OpenCode health capabilities must be an array of strings");
  }
  return value;
}

function matchesVersion(version: string, expected: string | RegExp): boolean {
  return typeof expected === "string" ? version === expected : expected.test(version);
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

function abortReason(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  return new Error(typeof reason === "string" ? reason : "OpenCode runtime aborted");
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
): Promise<void> {
  return new Promise((resolve) => {
    if (alreadyExited) {
      resolve();
      return;
    }
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.removeListener("close", finish);
      child.removeListener("exit", finish);
      child.removeListener("error", finish);
      resolve();
    };
    child.once("close", finish);
    child.once("exit", finish);
    child.once("error", finish);
    timer = setTimeout(() => {
      onTimeout();
      // A child can fail to emit close when a test double does not model a
      // signal. Resolve so cleanup never retains a stale supervisor forever.
      setTimeout(finish, 25);
    }, timeoutMs);
  });
}
