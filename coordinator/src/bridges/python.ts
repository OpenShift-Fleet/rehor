import type {
  ConfigPreparationRequest,
  ConfigPreparationResult,
  PreflightRequest,
  PreflightResult,
  PreflightScriptResult,
  PythonBridge,
} from "../ports/python-bridge";

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
    this.env = options.env;
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
    if (signal?.aborted) throw abortError(signal.reason);

    const child = Bun.spawn([this.executable, "-m", "bot.coordinator_bridge"], {
      cwd: this.cwd ?? (typeof request.scriptDir === "string" ? request.scriptDir : undefined),
      env: this.env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
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
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);

      if (aborted || signal?.aborted) throw abortError(signal?.reason);
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
  if (action !== "start" && action !== "skip" && action !== "error") {
    throw new PythonBridgeError("preflight.action must be start, skip, or error");
  }
  const scripts = arrayValue(object.scripts, "preflight.scripts").map((script, index) => {
    const entry = record(script, `preflight.scripts[${index}]`);
    const status = stringValue(entry.status, `preflight.scripts[${index}].status`);
    if (status !== "start" && status !== "skip" && status !== "error") {
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
  if (strategy !== "replace" && strategy !== "append" && strategy !== "ignore") {
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
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function abortError(reason: unknown): Error {
  const error = new Error(
    reason === undefined ? "Python coordinator bridge aborted" : String(reason),
  );
  error.name = "AbortError";
  return error;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
