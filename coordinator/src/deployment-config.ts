import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { OpenCodeDeploymentConfig } from "./runtimes/opencode";
import { validateAdditionalDirectories } from "./runtimes/opencode/render";

/** Validate the deployment-owned allowlist independently of the gateway URL. */
export function resolveModelGatewayPorts(value: unknown): { http: number; https: number } {
  if (value === undefined) return { http: 8450, https: 443 };
  if (
    value === null ||
    typeof value !== "object" ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    throw new Error("modelGatewayPorts must be a plain object with http and/or https ports");
  }
  const ports = { http: 8450, https: 443 };
  for (const key of Reflect.ownKeys(value)) {
    if (key !== "http" && key !== "https") {
      throw new Error("modelGatewayPorts contains an unknown key");
    }
    const port = (value as Record<string, unknown>)[key];
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`modelGatewayPorts.${key} must be an integer from 1 to 65535`);
    }
    ports[key] = port;
  }
  return ports;
}

/** Instance convention: the deployment config sits beside the instance
 * configuration at BOT_CONFIG_PATH/opencode-deployment.json; the packaged
 * default stays the fallback when it is absent. */
async function instanceDeploymentConfigPath(): Promise<URL | string> {
  const instanceConfigPath = process.env.BOT_CONFIG_PATH;
  if (instanceConfigPath) {
    const candidate = resolve(instanceConfigPath, "opencode-deployment.json");
    try {
      await access(candidate);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return new URL("../opencode-deployment.default.json", import.meta.url);
}

/** Load the packaged provider defaults unless an explicit deployment file is supplied. */
export async function loadOpenCodeDeploymentConfig(
  path?: string,
): Promise<OpenCodeDeploymentConfig> {
  const configPath = path ? resolve(path) : await instanceDeploymentConfigPath();
  const raw = JSON.parse(await readFile(configPath, "utf8")) as unknown;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("OpenCode deployment config must be a JSON object");
  }
  validateAdditionalDirectories((raw as OpenCodeDeploymentConfig).additionalDirectories);
  resolveModelGatewayPorts((raw as OpenCodeDeploymentConfig).modelGatewayPorts);
  return raw as OpenCodeDeploymentConfig;
}
