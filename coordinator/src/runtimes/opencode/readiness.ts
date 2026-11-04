import { realpath } from "node:fs/promises";

import { createOpenCodeFetch, type OpenCodeFetch } from "./environment";

export interface OpenCodeHealth {
  healthy: boolean;
  version: string;
  capabilities?: { persistentPty?: boolean };
}

export class OpenCodeReadinessError extends Error {
  constructor(
    message: string,
    readonly deterministic = false,
  ) {
    super(message);
    this.name = "OpenCodeReadinessError";
  }
}

export class HttpOpenCodeReadiness {
  private readonly fetchImpl: OpenCodeFetch;

  constructor(fetchImpl?: OpenCodeFetch) {
    this.fetchImpl = createOpenCodeFetch(fetchImpl);
  }

  async check(
    baseUrl: string,
    directory: string,
    signal: AbortSignal,
    password?: string,
  ): Promise<OpenCodeHealth> {
    const headers =
      password === undefined
        ? undefined
        : {
            authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
          };
    const healthResponse = await this.fetchImpl(`${baseUrl}/api/info`, { signal, headers });
    if (!healthResponse.ok) {
      throw new OpenCodeReadinessError(
        `OpenCode server info returned HTTP ${healthResponse.status} at ${baseUrl}/api/info`,
        // Authentication cannot recover by polling; server failures remain
        // retryable within the supervisor's shared startup deadline.
        healthResponse.status === 401 || healthResponse.status === 403,
      );
    }
    const health = await readJson(healthResponse, "health");
    if (
      typeof health.version !== "string" ||
      health.version.length === 0 ||
      !Number.isSafeInteger(health.pid) ||
      (health.pid as number) <= 0 ||
      !Array.isArray(health.urls) ||
      health.urls.some((url) => typeof url !== "string") ||
      typeof health.paths !== "object" ||
      health.paths === null ||
      typeof (health.paths as Record<string, unknown>).tmp !== "string"
    ) {
      throw new OpenCodeReadinessError(
        "OpenCode server info response must contain version, pid, urls and paths.tmp",
        true,
      );
    }

    const pathUrl = new URL(`${baseUrl}/api/location`);
    pathUrl.searchParams.set("location[directory]", directory);
    const pathResponse = await this.fetchImpl(pathUrl, { signal, headers });
    if (!pathResponse.ok) {
      throw new OpenCodeReadinessError(
        `OpenCode path check returned HTTP ${pathResponse.status} at ${pathUrl}`,
        pathResponse.status === 401 || pathResponse.status === 403,
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

function parseCapabilities(value: unknown): OpenCodeHealth["capabilities"] {
  if (value === undefined) return undefined;
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    ("persistentPty" in value && typeof value.persistentPty !== "boolean")
  ) {
    throw new OpenCodeReadinessError("OpenCode server capabilities must be an object", true);
  }
  return "persistentPty" in value ? { persistentPty: value.persistentPty as boolean } : {};
}

export function matchesVersion(version: string, expected: string | RegExp): boolean {
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
