import { realpath } from "node:fs/promises";

import { createOpenCodeFetch, type OpenCodeFetch } from "./environment";

export interface OpenCodeHealth {
  healthy: boolean;
  version: string;
  capabilities?: readonly string[];
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

function parseCapabilities(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new OpenCodeReadinessError("OpenCode health capabilities must be an array of strings");
  }
  return value;
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
