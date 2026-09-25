import { spawn } from "node:child_process";
import type { Readable } from "node:stream";

import { isInstructionStrategy } from "../instructions";
import {
  type ConfigPreparationRequest,
  type ConfigPreparationResult,
  isPreflightAction,
  type PreflightRequest,
  type PreflightResult,
  type PreflightScriptResult,
  type PythonBridge,
} from "../ports/python-bridge";
import type { McpServerConfig } from "../ports/runtime-config";
import { abortError, isRecord } from "../utils";

const PROTOCOL_VERSION = 1;

export interface PythonBridgeOptions {
  executable?: string;
  cwd?: string;
  env?: Record<string, string>;
}

export class PythonBridgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PythonBridgeError";
  }
}

/** Process adapter for the existing Python preflight/config implementation. */
export class PythonCoordinatorBridge implements PythonBridge {
  private readonly executable: string;
  private readonly cwd: string | undefined;
  private readonly env: Record<string, string> | undefined;

  constructor(options: PythonBridgeOptions = {}) {
    this.executable = options.executable ?? "python3";
    this.cwd = options.cwd;
    this.env = options.env ? mergeEnvironment(options.env) : undefined;
  }

  async preflight(input: PreflightRequest, signal?: AbortSignal): Promise<PreflightResult | null> {
    const result = await this.request(
      { protocolVersion: PROTOCOL_VERSION, operation: "preflight", ...input },
      signal,
    );
    return parsePreflightResult(result);
  }

  async prepareConfig(
    input: ConfigPreparationRequest,
    signal?: AbortSignal,
  ): Promise<ConfigPreparationResult> {
    const result = await this.request(
      { protocolVersion: PROTOCOL_VERSION, operation: "prepare", ...input },
      signal,
    );
    return parseConfigPreparationResult(result);
  }

  private async request(request: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw abortError(signal.reason, "Python coordinator bridge aborted");

    const child = spawn(this.executable, ["-m", "bot.coordinator_bridge"], {
      cwd: this.cwd ?? (typeof request.scriptDir === "string" ? request.scriptDir : undefined),
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let aborted = false;
    const onAbort = (): void => {
      aborted = true;
      child.kill();
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      child.stdin.write(`${JSON.stringify(request)}\n`);
      child.stdin.end();
      const [stdout, stderr, exitCode] = await Promise.all([
        readStream(child.stdout),
        readStream(child.stderr),
        waitForExit(child),
      ]);

      if (aborted || signal?.aborted) {
        throw abortError(signal?.reason, "Python coordinator bridge aborted");
      }
      if (exitCode !== 0) {
        const detail = stderr.trim() || `process exited with code ${exitCode}`;
        throw new PythonBridgeError(`Python coordinator bridge failed: ${detail}`);
      }

      let response: unknown;
      try {
        response = JSON.parse(stdout);
      } catch (error) {
        throw new PythonBridgeError(
          `Python coordinator bridge returned invalid JSON: ${describe(error)}`,
        );
      }
      return parseBridgeResponse(response);
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }
}

function parseBridgeResponse(value: unknown): unknown {
  if (!isRecord(value) || value.protocolVersion !== PROTOCOL_VERSION || value.ok !== true) {
    throw new PythonBridgeError("Python coordinator bridge returned an invalid response envelope");
  }
  return value.result;
}

function parsePreflightResult(value: unknown): PreflightResult | null {
  if (value === null) return null;
  const object = record(value, "preflight result");
  const action = stringValue(object.action, "preflight.action");
  if (!isPreflightAction(action)) {
    throw new PythonBridgeError("preflight.action must be start, skip, or error");
  }
  const scripts = arrayValue(object.scripts, "preflight.scripts").map((script, index) => {
    const entry = record(script, `preflight.scripts[${index}]`);
    const status = stringValue(entry.status, `preflight.scripts[${index}].status`);
    if (!isPreflightAction(status)) {
      throw new PythonBridgeError(`preflight.scripts[${index}].status is invalid`);
    }
    return {
      name: stringValue(entry.name, `preflight.scripts[${index}].name`),
      status,
      content: stringValue(entry.content, `preflight.scripts[${index}].content`),
    } satisfies PreflightScriptResult;
  });

  return {
    action,
    prompt: stringValue(object.prompt, "preflight.prompt"),
    transcript: stringValue(object.transcript, "preflight.transcript"),
    scripts,
  };
}

function parseConfigPreparationResult(value: unknown): ConfigPreparationResult {
  const object = record(value, "config preparation result");
  const strategy = stringValue(object.claudeMdStrategy, "config.claudeMdStrategy");
  if (!isInstructionStrategy(strategy)) {
    throw new PythonBridgeError("config.claudeMdStrategy is invalid");
  }
  const envs = object.envs === null ? null : stringArray(object.envs, "config.envs");
  return {
    model: stringValue(object.model, "config.model"),
    maxTurns: positiveInteger(object.maxTurns, "config.maxTurns"),
    intervalSeconds: nonNegativeNumber(object.intervalSeconds, "config.intervalSeconds"),
    idleIntervalSeconds: nonNegativeNumber(
      object.idleIntervalSeconds,
      "config.idleIntervalSeconds",
    ),
    cycleTimeoutSeconds: positiveNumber(object.cycleTimeoutSeconds, "config.cycleTimeoutSeconds"),
    idleReminderCooldownSeconds: nonNegativeNumber(
      object.idleReminderCooldownSeconds,
      "config.idleReminderCooldownSeconds",
    ),
    workflow: stringValue(object.workflow, "config.workflow"),
    source: stringValue(object.source, "config.source"),
    envs,
    activeEnvs: stringArray(object.activeEnvs, "config.activeEnvs"),
    claudeMdStrategy: strategy,
    idleCycleLimit: nonNegativeInteger(object.idleCycleLimit, "config.idleCycleLimit"),
    remoteAgentDir: nullableString(object.remoteAgentDir, "config.remoteAgentDir"),
    sharedAgentDir: nullableString(object.sharedAgentDir, "config.sharedAgentDir"),
    claudeMdPath: stringValue(object.claudeMdPath, "config.claudeMdPath"),
    mcpServers: parseMcpServers(object.mcpServers, "config.mcpServers"),
    openCodeMcpServers: parseRequiredOpenCodeMcpServers(object.openCodeMcpServers),
    allowedTools: stringArray(object.allowedTools ?? [], "config.allowedTools"),
    optionalMcpServers: stringArray(object.optionalMcpServers ?? [], "config.optionalMcpServers"),
  };
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new PythonBridgeError(`${path} must be an object`);
  return value;
}

function arrayValue(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new PythonBridgeError(`${path} must be an array`);
  return value;
}

function stringArray(value: unknown, path: string): string[] {
  return arrayValue(value, path).map((entry, index) => stringValue(entry, `${path}[${index}]`));
}

function parseRequiredOpenCodeMcpServers(value: unknown): Record<string, McpServerConfig> {
  if (value === undefined) {
    throw new PythonBridgeError("config.openCodeMcpServers is required");
  }
  return parseMcpServers(value, "config.openCodeMcpServers");
}

function parseMcpServers(value: unknown, path: string): Record<string, McpServerConfig> {
  const servers = record(value, path);
  return Object.fromEntries(
    Object.entries(servers).map(([name, config]) => [
      name,
      parseMcpServer(config, `${path}.${name}`),
    ]),
  );
}

function parseMcpServer(value: unknown, path: string): McpServerConfig {
  const config = record(value, path);
  if (typeof config.command === "string") {
    const type = config.type;
    if (type !== undefined && type !== "stdio") {
      throw new PythonBridgeError(`${path}.type must be stdio when command is provided`);
    }
    return {
      ...(type === undefined ? {} : { type }),
      command: config.command,
      ...(config.args === undefined ? {} : { args: stringArray(config.args, `${path}.args`) }),
      ...(config.env === undefined ? {} : { env: stringRecord(config.env, `${path}.env`) }),
      ...(config.timeout === undefined
        ? {}
        : { timeout: finiteNumber(config.timeout, `${path}.timeout`) }),
      ...(config.alwaysLoad === undefined
        ? {}
        : { alwaysLoad: booleanValue(config.alwaysLoad, `${path}.alwaysLoad`) }),
    };
  }

  if (config.type !== "http" && config.type !== "sse") {
    throw new PythonBridgeError(`${path}.type must be http or sse`);
  }
  return {
    type: config.type,
    url: stringValue(config.url, `${path}.url`),
    ...(config.headers === undefined
      ? {}
      : { headers: stringRecord(config.headers, `${path}.headers`) }),
    ...(config.timeout === undefined
      ? {}
      : { timeout: finiteNumber(config.timeout, `${path}.timeout`) }),
    ...(config.alwaysLoad === undefined
      ? {}
      : { alwaysLoad: booleanValue(config.alwaysLoad, `${path}.alwaysLoad`) }),
  };
}

function stringRecord(value: unknown, path: string): Record<string, string> {
  const object = record(value, path);
  return Object.fromEntries(
    Object.entries(object).map(([key, entry]) => [key, stringValue(entry, `${path}.${key}`)]),
  );
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new PythonBridgeError(`${path} must be a boolean`);
  return value;
}

function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new PythonBridgeError(`${path} must be a finite number`);
  }
  return value;
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== "string") throw new PythonBridgeError(`${path} must be a string`);
  return value;
}

function nullableString(value: unknown, path: string): string | null {
  if (value === null) return null;
  return stringValue(value, path);
}

function positiveInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new PythonBridgeError(`${path} must be a positive safe integer`);
  }
  return value as number;
}

function nonNegativeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new PythonBridgeError(`${path} must be a non-negative safe integer`);
  }
  return value as number;
}

function positiveNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new PythonBridgeError(`${path} must be a positive finite number`);
  }
  return value;
}

function nonNegativeNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new PythonBridgeError(`${path} must be a non-negative finite number`);
  }
  return value;
}

async function readStream(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? -1));
  });
}

function mergeEnvironment(overrides: Record<string, string>): Record<string, string> {
  const inherited: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) inherited[key] = value;
  }
  return { ...inherited, ...overrides };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
