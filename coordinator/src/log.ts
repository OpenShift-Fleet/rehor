import { AsyncLocalStorage } from "node:async_hooks";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export type LogFields = Readonly<Record<string, string | number | boolean | null | undefined>>;
export type LogLevel = "DEBUG" | "INFO" | "WARNING" | "ERROR" | "CRITICAL";
export interface Logger {
  child(fields: LogFields): Logger;
  scope<T>(fields: LogFields, action: () => T): T;
  log(level: LogLevel, message: string, fields?: LogFields, error?: unknown): void;
}
export const nullLogger: Logger = {
  child: () => nullLogger,
  scope: (_fields, action) => action(),
  log: () => undefined,
};
export const MAX_FIELD_BYTES = 8192;

export function safeText(text: string, environment: NodeJS.ProcessEnv = process.env): string {
  let result = text;
  // Redact before truncation so a cap never removes the context identifying a secret.
  for (const [key, value] of Object.entries(environment)) {
    if (
      /TOKEN|SECRET|KEY|PASSWORD|AUTH|CREDENTIAL/i.test(key) &&
      value &&
      value.trim().length >= 6
    ) {
      result = result.split(value.trim()).join("[REDACTED]");
    }
  }
  result = result
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
      "[REDACTED PRIVATE KEY]",
    )
    .replace(/(Bearer\s+)[A-Za-z0-9_\-.~+/]+=*/gi, "$1[REDACTED]")
    .replace(/:\/\/([^:\s]+):([^@\s]+)@/g, "://$1:[REDACTED]@")
    .replace(
      /(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{22,}|glpat-[A-Za-z0-9-]{20,}|sk-(?:ant-)?[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})/g,
      "[REDACTED]",
    )
    .replace(/https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/g, "[REDACTED_SLACK_WEBHOOK]")
    .replace(
      /((?:authorization|api[_-]?key|password|token|secret)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$1[REDACTED]",
    );
  if (Buffer.byteLength(result) <= MAX_FIELD_BYTES) return result;
  return `${Buffer.from(result)
    .subarray(0, MAX_FIELD_BYTES - 18)
    .toString("utf8")
    .replace(/\uFFFD$/, "")}...[TRUNCATED]`;
}

/** Error properties are deliberately not spread/JSON-serialized. */
export function errorDetails(value: unknown, environment?: NodeJS.ProcessEnv): string {
  const seen = new Set<unknown>();
  const parts: string[] = [];
  let current = value;
  for (let depth = 0; current !== undefined && depth < 8; depth++) {
    if (seen.has(current)) {
      parts.push("[cyclic cause]");
      break;
    }
    seen.add(current);
    if (current instanceof Error) {
      parts.push(safeText(current.stack ?? `${current.name}: ${current.message}`, environment));
      current = current.cause;
    } else {
      parts.push(
        typeof current === "string" ? safeText(current, environment) : "[non-Error cause omitted]",
      );
      break;
    }
  }
  return safeText(parts.join("\nCaused by: "), environment);
}

export interface StructuredLoggerOptions {
  environment?: NodeJS.ProcessEnv;
  write?: (line: string) => void;
  name?: string;
}

interface LogSink {
  name: "file" | "stdout";
  write(line: string): void;
}

// Synchronous descriptor writes contain EPIPE/other stream failures at the call
// boundary, without an asynchronous unhandled stdout/stderr 'error' event.
function writeDescriptor(fd: number, line: string): void {
  const bytes = Buffer.from(line);
  for (let offset = 0; offset < bytes.length; ) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset);
    if (written <= 0) throw new Error("log descriptor made no write progress");
    offset += written;
  }
}

function stdoutSink(options: StructuredLoggerOptions): LogSink {
  return {
    name: "stdout",
    write: options.write ?? ((line) => writeDescriptor(process.stdout.fd, line)),
  };
}

export function createStructuredLogger(options: StructuredLoggerOptions = {}): Logger {
  return loggerWithSinks(options, [stdoutSink(options)]);
}

function loggerWithSinks(options: StructuredLoggerOptions, sinks: readonly LogSink[]): Logger {
  const environment = options.environment ?? process.env;
  const context = new AsyncLocalStorage<LogFields>();
  const failedSinks = new Set<string>();
  const reportFailure = (
    sink: string,
    error: unknown,
    data: Record<string, unknown> = {},
  ): void => {
    // Warn once per continuous sink outage, then allow another warning after recovery.
    if (failedSinks.has(sink)) return;
    failedSinks.add(sink);
    try {
      const correlation = (key: string): string | null =>
        typeof data[key] === "string" ? safeText(data[key], environment) : null;
      const warning = {
        timestamp: new Date().toISOString(),
        level: "WARNING",
        logger: "coordinator.logging",
        message: "Logging sink failed; emission is best effort",
        sink,
        run_id: correlation("run_id"),
        attempt_id: correlation("attempt_id"),
        task_key: correlation("task_key"),
        model: correlation("model"),
        cost: null,
        exc_info: errorDetails(error, environment),
      };
      // Deliberately bypass all configured sinks and logger.log; stderr failure
      // must neither recurse nor replace a business error already in flight.
      writeDescriptor(process.stderr.fd, `${JSON.stringify(warning)}\n`);
    } catch {
      /* No remaining safe reporting path. */
    }
  };
  const make = (bound: LogFields): Logger => ({
    child: (fields) => make({ ...bound, ...fields }),
    scope: (fields, action) => context.run({ ...context.getStore(), ...fields }, action),
    log(level, message, fields = {}, error) {
      try {
        if (level === "DEBUG" && environment.DEBUG !== "true") return;
        const data: Record<string, unknown> = {
          timestamp: new Date().toISOString(),
          level,
          logger: options.name ?? "coordinator",
          message,
          run_id: null,
          task_key: null,
          model: null,
          cost: null,
          ...bound,
          ...context.getStore(),
          ...fields,
        };
        if (error !== undefined) data.exc_info = errorDetails(error, environment);
        for (const [key, value] of Object.entries(data)) {
          if (typeof value === "string") data[key] = safeText(value, environment);
          else if (typeof value === "number" && !Number.isFinite(value)) data[key] = null;
        }
        const line = `${JSON.stringify(data)}\n`;
        failedSinks.delete("format");
        for (const sink of sinks) {
          try {
            sink.write(line);
            failedSinks.delete(sink.name);
          } catch (error) {
            reportFailure(sink.name, error, data);
          }
        }
      } catch (error) {
        reportFailure("format", error);
      }
    },
  });
  return make({});
}

/** CLI-owned synchronous sink: bounded records, deterministic rotation, no open handle. */
export function createFileLogger(
  options: StructuredLoggerOptions & {
    dataDirectory: string;
    maxBytes?: number;
    backupCount?: number;
  },
): Logger {
  const environment = options.environment ?? process.env;
  mkdirSync(options.dataDirectory, { recursive: true, mode: 0o700 });
  const root = realpathSync(options.dataDirectory);
  const path = resolve(root, environment.BOT_LOG_FILE || "bot.log");
  const jailed = (candidate: string): void => {
    const rel = relative(root, candidate);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
      throw new Error("BOT_LOG_FILE path jail violation");
  };
  jailed(path);
  // Resolve existing ancestors before creating directories (including symlinks).
  let ancestor = dirname(path);
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  jailed(realpathSync(ancestor));
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  jailed(realpathSync(dirname(path)));
  const maxBytes = options.maxBytes ?? 10 * 1024 * 1024;
  const backups = options.backupCount ?? 5;
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes <= 0 ||
    !Number.isSafeInteger(backups) ||
    backups < 0
  ) {
    throw new Error("invalid log rotation limits");
  }
  const check = (file: string): void => {
    if (!existsSync(file)) return;
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("unsafe log file");
    chmodSync(file, 0o600);
  };
  check(path);
  const fileSink: LogSink = {
    name: "file",
    write(line) {
      jailed(realpathSync(dirname(path)));
      check(path);
      if (existsSync(path) && lstatSync(path).size + Buffer.byteLength(line) > maxBytes) {
        for (let index = backups; index >= 1; index--) {
          const target = `${path}.${index}`;
          check(target);
          if (index === backups && existsSync(target)) unlinkSync(target);
          const source = index === 1 ? path : `${path}.${index - 1}`;
          check(source);
          if (existsSync(source)) renameSync(source, target);
        }
        if (backups === 0) unlinkSync(path);
      }
      const fd = openSync(
        path,
        constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        if (fstatSync(fd).nlink !== 1) throw new Error("unsafe log file");
        appendFileSync(fd, line);
      } finally {
        closeSync(fd);
      }
    },
  };
  return loggerWithSinks({ ...options, environment }, [fileSink, stdoutSink(options)]);
}
