import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { OpenCodeDeploymentConfig } from "./runtimes/opencode";
import { validateAdditionalDirectories } from "./runtimes/opencode/render";

/** Load the packaged provider defaults unless an explicit deployment file is supplied. */
export async function loadOpenCodeDeploymentConfig(
  path?: string,
): Promise<OpenCodeDeploymentConfig> {
  const configPath = path
    ? resolve(path)
    : new URL("../opencode-deployment.default.json", import.meta.url);
  const raw = JSON.parse(await readFile(configPath, "utf8")) as unknown;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("OpenCode deployment config must be a JSON object");
  }
  validateAdditionalDirectories((raw as OpenCodeDeploymentConfig).additionalDirectories);
  return raw as OpenCodeDeploymentConfig;
}
