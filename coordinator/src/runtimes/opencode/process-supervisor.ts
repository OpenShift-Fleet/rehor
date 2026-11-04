import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { classifyDiagnostic } from "../../diagnostics";
import { type Logger, nullLogger, safeText } from "../../log";

import {
  abortReason,
  assertPositiveInteger,
  boundedOperation,
  redactSensitiveText,
  stableJson,
} from "../shared";
import { buildOpenCodeEnvironment, type OpenCodeEnvironmentOptions } from "./environment";
import { renderOpenCodePolicyPlugin } from "./policy-plugin";
import {
  HttpOpenCodeReadiness,
  matchesVersion,
  type OpenCodeHealth,
  OpenCodeReadinessError,
} from "./readiness";
import { writeOpenCodeConfig } from "./render";
import type { OpenCodePermissionRule, RenderedOpenCodeConfig } from "./types";
import { OpenCodeWorkspaceOwnershipError, resolveApprovedWorkspace } from "./workspace";

/** Pinned because state/config isolation is verified against this CLI contract. */
export const OPENCODE_VERSION = "2.1.2" as const;
const STARTUP_OUTPUT_LIMIT = 16_384;
const STARTUP_DIAGNOSTIC_LIMIT = 2_048;

export interface OpenCodeServerInfo extends OpenCodeHealth {
  baseUrl: string;
  hostname: string;
  port: number;
  /** Canonical, validated worktree path used for child cwd and client requests. */
  directory: string;
  configHash?: string;
  /** Private per-process credential; never include in diagnostics or logs. */
  password?: string;
}

export interface OpenCodeSupervisorOptions extends OpenCodeEnvironmentOptions {
  logger?: Logger;
  command?: string;
  hostname?: string;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  expectedVersion?: string | RegExp;
  /** Immutable, already validated configuration for this server instance. */
  renderedConfig?: RenderedOpenCodeConfig;
  /** Required by start; absolute root containing only approved worktrees. */
  workspaceRoot?: string;
  /** Expected owner UID for the canonical worktree directory. */
  workspaceOwnerUid?: number;
  /** Bound verification after SIGKILL when a group ignores the grace signal. */
  killVerificationTimeoutMs?: number;
  /** Optional caller-owned state directory; otherwise one is created per start. */
  stateDirectory?: string;
  spawnProcess?: OpenCodeSpawn;
}

export type OpenCodeSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

type RequiredOpenCodeSupervisorOption =
  | "command"
  | "hostname"
  | "startupTimeoutMs"
  | "shutdownTimeoutMs"
  | "killVerificationTimeoutMs";

/** The OpenCode process group survived SIGKILL; its processes may leak. */
export class OpenCodeProcessLeakError extends Error {
  constructor(message = "OpenCode process group remained alive after SIGKILL") {
    super(message);
    this.name = "OpenCodeProcessLeakError";
  }
}

export interface OpenCodeServerController {
  readonly diagnostics?: string;
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
  private stopPromise?: Promise<void>;
  private exited = false;
  private termSent = false;
  private _crashError?: Error;
  private crashController = new AbortController();
  private outputCleanup?: () => void;
  private startupOutput = "";
  private diagnosticCount = 0;
  private stateDirectory?: string;
  private ownsStateDirectory = false;
  private readonly renderedConfig?: RenderedOpenCodeConfig;

  constructor(options: OpenCodeSupervisorOptions = {}) {
    this.renderedConfig = options.renderedConfig;
    this.options = {
      ...options,
      passthrough: [
        ...new Set([
          ...(options.passthrough ?? []),
          ...(options.renderedConfig?.requiredEnvironment ?? []),
        ]),
      ],
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

  get diagnostics(): string {
    return this.startupDiagnostic();
  }

  async start(directory: string, signal: AbortSignal): Promise<OpenCodeServerInfo> {
    if (this.child || this.server) throw new Error("OpenCode server already started");
    if (signal.aborted) throw abortReason(signal);
    if (this.renderedConfig !== undefined) {
      await Promise.all(
        ["opencode.json", "opencode.jsonc"].map((file) =>
          assertNoSystemManagedOpenCodeConfig(join("/etc/opencode", file)),
        ),
      );
    }

    const workspaceDirectory = await resolveApprovedWorkspace(
      directory,
      this.options.workspaceRoot,
      this.options.workspaceOwnerUid,
    ).catch((error: unknown) => {
      if (error instanceof OpenCodeWorkspaceOwnershipError) {
        (this.options.logger ?? nullLogger).log("ERROR", "OpenCode workspace ownership mismatch", {
          workspace: safeText(error.directory, this.options.base),
          actual_uid: error.actualUid,
          expected_uid: error.expectedUid,
        });
      }
      throw error;
    });
    if (signal.aborted) throw abortReason(signal);

    const configHash = this.renderedConfig?.hash;

    const stateDirectory = await this.prepareStateDirectory();
    const environment = buildOpenCodeEnvironment({
      ...this.options,
      // GitOps resources live under isolated XDG_CONFIG_HOME/opencode so
      // checked-out project resources retain their later native precedence.
      configDirectory: undefined,
      databasePath: join(stateDirectory, "opencode.db"),
    });
    const originalConfigHome = environment.XDG_CONFIG_HOME;
    const originalDataHome = environment.XDG_DATA_HOME;
    environment.XDG_CONFIG_HOME = join(stateDirectory, "xdg-config");
    // V2 imports legacy auth.json from data home when creating a database.
    environment.XDG_DATA_HOME = join(stateDirectory, "xdg-data");
    // Global.home still bounds V2's ambient AGENTS discovery. Keep it outside
    // the worktree so traversal stops at the project root, while shell HOME
    // remains the caller's original operational home.
    environment.OPENCODE_TEST_HOME = stateDirectory;
    const password = randomBytes(32).toString("base64url");
    // --stdio consumes and deletes this before tool processes inherit the environment.
    environment.OPENCODE_PASSWORD = password;
    // These flags are controlled by the runner, not inherited from ambient env.
    // Native project AGENTS.md and configured skill discovery remain enabled.
    environment.OPENCODE_DISABLE_MODELS_FETCH = "1";
    environment.NPM_CONFIG_OFFLINE = "true";
    environment.npm_config_offline = "true";
    if (this.renderedConfig !== undefined) {
      try {
        const files = await writeOpenCodeConfig(stateDirectory, this.renderedConfig);
        environment.OPENCODE_CONFIG = files.configPath;
        // Inherited config content/permissions are excluded by the sanitizer;
        // these runner-owned values override top-level settings.
        const enforcement = JSON.parse(this.renderedConfig.enforcementJson) as {
          permissions: OpenCodePermissionRule[];
          plugins?: unknown[];
        };
        const boundary = enforcement.permissions;
        const shellPluginDirectory = join(stateDirectory, "rehor-policy");
        const shellPlugin = join(shellPluginDirectory, "index.js");
        await mkdir(shellPluginDirectory, { recursive: true });
        await writeFile(join(shellPluginDirectory, "package.json"), '{"type":"module"}\n');
        await writeFile(
          shellPlugin,
          renderOpenCodePolicyPlugin(originalConfigHome, boundary, originalDataHome),
        );
        // Configured local plugins must target directories in V2; a file path
        // is ignored by the native source scanner even when its module is valid.
        enforcement.plugins = [
          ...(enforcement.plugins ?? []),
          pathToFileURL(shellPluginDirectory).href,
        ];
        environment.OPENCODE_CONFIG_CONTENT = stableJson(enforcement);
        // writeOpenCodeConfig owns the authoritative GLOBAL native policies.
        // Keep those out of inline content, whose policy authority is lower.
      } catch (error) {
        await this.cleanupStateDirectory();
        throw error;
      }
    }
    const args = [
      "serve",
      "--stdio",
      `--hostname=${this.options.hostname}`,
      "--port=0",
      "--print-logs",
      `--log-level=${(this.options.base ?? process.env).DEBUG === "true" ? "debug" : "info"}`,
    ];
    (this.options.logger ?? nullLogger).log("INFO", "OpenCode server starting");
    const spawnProcess = this.options.spawnProcess ?? spawn;
    this.startupOutput = "";
    this.diagnosticCount = 0;
    let child: ChildProcess;
    try {
      child = spawnProcess(this.options.command, args, {
        cwd: workspaceDirectory,
        env: environment,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
    } catch (error) {
      await this.cleanupStateDirectory();
      throw error;
    }
    this.child = child;
    this.exited = false;
    this.termSent = false;
    this._crashError = undefined;
    this.crashController = new AbortController();

    const exitPromise = this.observeExit(child);
    const startupSignal = AbortSignal.any([signal, this.crashSignal]);
    const startupDeadline = Date.now() + this.options.startupTimeoutMs;
    try {
      const baseUrl = await this.waitForListening(child, startupSignal, startupDeadline);
      const health = await this.waitForReadiness(
        baseUrl,
        workspaceDirectory,
        startupSignal,
        startupDeadline,
        password,
      );
      this.server = {
        ...health,
        baseUrl: baseUrl.toString().replace(/\/$/, ""),
        hostname: baseUrl.hostname,
        port: Number(baseUrl.port),
        directory: workspaceDirectory,
        password,
        ...(configHash ? { configHash } : {}),
      };
      (this.options.logger ?? nullLogger).log("INFO", "OpenCode server ready", {
        version: health.version,
      });
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

  private async prepareStateDirectory(): Promise<string> {
    if (this.options.stateDirectory !== undefined) {
      await mkdir(this.options.stateDirectory, { recursive: true });
      this.stateDirectory = this.options.stateDirectory;
      this.ownsStateDirectory = false;
      return this.options.stateDirectory;
    }
    this.stateDirectory = await mkdtemp(join(tmpdir(), "rehor-opencode-"));
    this.ownsStateDirectory = true;
    return this.stateDirectory;
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
      await this.cleanupStateDirectory();
      return;
    }
    const child = this.child;
    try {
      const groupExists = (): boolean => {
        if (process.platform === "win32" || !child.pid) return false;
        try {
          process.kill(-child.pid, 0);
          return true;
        } catch (error) {
          if (isNoSuchProcess(error)) return false;
          if (isPermissionDenied(error)) return true;
          throw error;
        }
      };
      if (!this.exited || (groupExists() && !this.termSent)) {
        // EOF is the native --stdio lease release; retain process-group signaling
        // and escalation for tool descendants and a stuck server finalizer.
        child.stdin?.end();
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
      await this.cleanupStateDirectory();
    }
  }

  private async cleanupStateDirectory(): Promise<void> {
    if (!this.stateDirectory || !this.ownsStateDirectory) return;
    const directory = this.stateDirectory;
    this.stateDirectory = undefined;
    this.ownsStateDirectory = false;
    await rm(directory, { recursive: true, force: true });
  }

  private signalChild(child: ChildProcess, signal: NodeJS.Signals): void {
    if (signal === "SIGTERM") this.termSent = true;
    signalProcessTree(child, signal);
  }

  private observeExit(child: ChildProcess): Promise<void> {
    return new Promise((resolve, reject) => {
      const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        this.exited = true;
        if (!this.termSent && !this._crashError) {
          const error = new Error(
            this.server
              ? `OpenCode server crashed after startup (code=${code ?? "null"}, signal=${signal ?? "none"})`
              : `OpenCode server exited before readiness (code=${code ?? "null"}, signal=${signal ?? "none"})`,
          );
          this._crashError = this.withStartupOutput(error);
          this.crashController.abort(this._crashError);
          this.signalChild(child, "SIGTERM");
        }
        resolve();
      };
      const onError = (error: Error): void => {
        this.exited = true;
        const safeError = redactError(error);
        if (!this.termSent && !this._crashError) {
          this._crashError = this.withStartupOutput(safeError);
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
    if (diagnostic && !error.message.includes("OpenCode diagnostics (safe tail)")) {
      error.message = `${error.message}\nOpenCode diagnostics (safe tail):\n${diagnostic}`;
    }
    error.message = safeText(error.message, this.options.base);
    return error;
  }

  private startupDiagnostic(): string {
    return safeText(this.startupOutput, this.options.base).slice(-STARTUP_DIAGNOSTIC_LIMIT);
  }

  private waitForListening(
    child: ChildProcess,
    signal: AbortSignal,
    deadline: number,
  ): Promise<URL> {
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      let settled = false;

      const cleanup = (): void => {
        if (timer) clearTimeout(timer);
        child.removeListener("exit", onExit);
        child.removeListener("error", onError);
        signal.removeEventListener("abort", onAbort);
      };
      const finish = (error?: Error, url?: URL): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve(url as URL);
      };
      // Separate bounded line buffers prevent stdout/stderr fragments from joining.
      // Oversized lines are discarded wholesale, not sliced into possible secret tails.
      const collector = () => {
        let pending = "";
        let dropping = false;
        return (chunk: Buffer | string): void => {
          for (const fragment of chunk.toString().split(/(?<=\n)/)) {
            const complete = fragment.endsWith("\n");
            if (
              !dropping &&
              Buffer.byteLength(pending) + Buffer.byteLength(fragment) <= STARTUP_OUTPUT_LIMIT
            )
              pending += fragment;
            else dropping = true;
            if (complete) {
              if (!dropping) onLine(pending);
              pending = "";
              dropping = false;
            }
          }
        };
      };
      const onLine = (line: string): void => {
        const diagnostic = classifyDiagnostic(line);
        if (diagnostic) {
          const safe = safeText(diagnostic, this.options.base);
          this.startupOutput = appendBoundedOpenCodeOutput(this.startupOutput, `${safe}\n`);
          if (this.diagnosticCount++ < 64)
            (this.options.logger ?? nullLogger).log("WARNING", "OpenCode diagnostic", {
              diagnostic: safe,
            });
        }
        if (settled) return;
        let announcement: unknown;
        try {
          announcement = JSON.parse(line);
        } catch {
          return;
        }
        if (typeof announcement !== "object" || announcement === null || !("url" in announcement))
          return;
        const rawUrl = announcement.url;
        if (typeof rawUrl !== "string") {
          finish(new OpenCodeReadinessError("OpenCode server advertised an invalid URL"));
          return;
        }
        const url = URL.canParse(rawUrl) ? new URL(rawUrl) : undefined;
        const problem = !url
          ? "OpenCode server advertised an invalid URL"
          : url.protocol !== "http:"
            ? `OpenCode server advertised unapproved protocol ${url.protocol}`
            : url.hostname !== this.options.hostname
              ? `OpenCode server advertised unapproved host ${url.hostname}`
              : url.port === "" || url.port === "0"
                ? `OpenCode server advertised invalid port ${url.port || "default"}`
                : undefined;
        if (problem) {
          finish(new OpenCodeReadinessError(problem));
          return;
        }
        finish(undefined, url);
      };
      const onStdout = collector();
      const onStderr = collector();
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
        child.stdout?.removeListener("data", onStdout);
        child.stderr?.removeListener("data", onStderr);
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
      child.stdout?.on("data", onStdout);
      child.stderr?.on("data", onStderr);
      child.once("exit", onExit);
      child.once("error", onError);
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private async waitForReadiness(
    baseUrl: URL,
    directory: string,
    signal: AbortSignal,
    deadline: number,
    password: string,
  ): Promise<OpenCodeHealth> {
    const readiness = new HttpOpenCodeReadiness();
    let lastError: unknown;

    while (Date.now() < deadline) {
      if (signal.aborted) throw abortReason(signal);
      try {
        const health = await boundedOperation(
          (requestSignal) =>
            readiness.check(
              baseUrl.toString().replace(/\/$/, ""),
              directory,
              requestSignal,
              password,
            ),
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
        if (signal.aborted) throw abortReason(signal);
        const remaining = deadline - Date.now();
        if (remaining > 0) {
          await delay(Math.min(50, remaining), undefined, { signal }).catch(() => {
            throw abortReason(signal);
          });
        }
      }
    }

    const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
    throw new OpenCodeReadinessError(
      `OpenCode readiness failed for ${baseUrl}; verify client proxy/NO_PROXY configuration${detail}`,
    );
  }
}

/** Linux managed config loads above OPENCODE_CONFIG_CONTENT and breaks policy ownership. */
export async function assertNoSystemManagedOpenCodeConfig(
  path: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (platform !== "linux") return;
  try {
    await lstat(path);
  } catch (error) {
    if (isMissingPath(error)) return;
    throw error;
  }
  throw new OpenCodeReadinessError(
    `OpenCode system-managed config at ${path} conflicts with runner-enforced settings`,
    true,
  );
}

function redactError(error: Error): Error {
  error.message = redactSensitiveText(error.message);
  return error;
}

/** Keeps startup diagnostics bounded while waiting for the advertised URL. */
export function appendBoundedOpenCodeOutput(output: string, chunk: Buffer | string): string {
  return `${output}${chunk.toString()}`.slice(-STARTUP_OUTPUT_LIMIT);
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

function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid && process.platform !== "win32") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if (!isNoSuchProcess(error)) throw error;
    }
  }
  child.kill(signal);
}

function isPermissionDenied(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
}

function isNoSuchProcess(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH";
}

function isMissingPath(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function waitForExit(
  child: ChildProcess,
  timeoutMs: number,
  onTimeout: () => void,
  alreadyExited: boolean,
  processGroupExists: () => boolean,
  killVerificationTimeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let leaderExited = alreadyExited;
    let graceTimer: NodeJS.Timeout | undefined;
    let verificationTimer: NodeJS.Timeout | undefined;
    let groupPollTimer: NodeJS.Timeout | undefined;

    const cleanup = (): void => {
      if (graceTimer) clearTimeout(graceTimer);
      if (verificationTimer) clearTimeout(verificationTimer);
      if (groupPollTimer) clearInterval(groupPollTimer);
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
    const check = (): void => {
      if (settled || !leaderExited) return;
      try {
        if (!processGroupExists()) finish();
      } catch (error) {
        fail(error);
      }
    };
    const startGroupPolling = (): void => {
      if (!groupPollTimer) groupPollTimer = setInterval(check, 25);
    };
    const onExit = (): void => {
      leaderExited = true;
      startGroupPolling();
      check();
    };
    const onError = (error: Error): void => {
      leaderExited = true;
      startGroupPolling();
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
      check();
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
        if (!settled) fail(new OpenCodeProcessLeakError());
      }, killVerificationTimeoutMs);
    };

    if (!alreadyExited) {
      child.once("close", onExit);
      child.once("exit", onExit);
      child.once("error", onError);
    } else {
      startGroupPolling();
    }
    graceTimer = setTimeout(forceKill, timeoutMs);
    check();
  });
}
