import { lstat, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { type InstructionAssemblyRequest, resolveWorkflowDir } from "../../instructions";
import { isMissingFile } from "../../utils";
import { asObject } from "../shared";
import { OPEN_CODE_AGENTS_FILE, OPEN_CODE_RESOURCE_DIRECTORY_SET } from "./constants";
import type { JsonObject } from "./types";

export interface OpenCodeProjectFile {
  readonly path: string;
  readonly content: string;
}

export interface OpenCodeProjectConfiguration {
  readonly settings: JsonObject;
  readonly files: readonly OpenCodeProjectFile[];
}

const MAX_CONFIG_FILE_BYTES = 256 * 1024;
const MAX_PROJECT_FILES = 256;
const MAX_PROJECT_BYTES = 2 * 1024 * 1024;

/** Capture native guidance and selected profile once; policy is checked when rendering. */
export async function loadOpenCodeProjectConfig(
  agentDirectory: string | null | undefined,
  guidance?: Pick<InstructionAssemblyRequest, "scriptDir" | "workflow" | "sharedAgentDir">,
): Promise<OpenCodeProjectConfiguration> {
  const profile = await loadProfileConfig(agentDirectory);
  if (!guidance) return profile;
  const layers = [
    ["core", join(guidance.scriptDir, "presets", "core")],
    ["shared", guidance.sharedAgentDir],
    ["workflow", resolveWorkflowDir(guidance.scriptDir, guidance.workflow, agentDirectory)],
  ] as const;
  const files = [...profile.files];
  const instructions: string[] = [];
  for (const [name, directory] of layers) {
    const path = `instructions/rehor/${name}.md`;
    if (
      files.some(
        (file) =>
          file.path === path ||
          path.startsWith(`${file.path}/`) ||
          file.path.startsWith(`${path}/`),
      )
    ) {
      throw new Error(`instance .opencode/${path} conflicts with reserved guidance path`);
    }
    const content = directory
      ? await readOptionalTextFile(join(directory, OPEN_CODE_AGENTS_FILE))
      : undefined;
    if (content === undefined) {
      if (name === "core") throw new Error(`core AGENTS.md not found at ${directory}`);
      if (
        directory &&
        (await lstat(join(directory, "CLAUDE.md")).catch((error: unknown) => {
          if (isMissingFile(error)) return undefined;
          throw error;
        }))
      ) {
        throw new Error(
          `Migrate ${name} guidance at ${directory}/CLAUDE.md to AGENTS.md for OpenCode`,
        );
      }
      continue;
    }
    files.push({ path, content });
    instructions.push(`.opencode/${path}`);
  }
  // Validate profile references before adding generated files to their available paths.
  if (profile.settings.instructions !== undefined) {
    normalizeOpenCodeInstructionPaths(profile.settings.instructions, profile.files);
  }
  if (
    files.length > MAX_PROJECT_FILES ||
    files.reduce((size, file) => size + Buffer.byteLength(file.content), 0) > MAX_PROJECT_BYTES
  ) {
    throw new Error("OpenCode project files exceed snapshot limits");
  }
  return {
    settings: {
      ...profile.settings,
      instructions: [...instructions, ...((profile.settings.instructions ?? []) as string[])],
    },
    files: files.sort((left, right) => left.path.localeCompare(right.path)),
  };
}

async function loadProfileConfig(
  agentDirectory: string | null | undefined,
): Promise<OpenCodeProjectConfiguration> {
  if (!agentDirectory) return { settings: {}, files: [] };
  const root = resolve(agentDirectory);
  const stats = await lstat(root);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error("selected instance agent directory must be a directory, not a symlink");
  }
  const raw = await readOptionalTextFile(join(root, "opencode.json"));
  let settings: unknown = {};
  try {
    if (raw !== undefined) settings = JSON.parse(raw);
  } catch {
    throw new Error("instance opencode.json must contain valid JSON");
  }
  if (!asObject(settings)) throw new Error("instance opencode.json must be a JSON object");
  const files: OpenCodeProjectFile[] = [];
  const agents = await readOptionalTextFile(join(root, OPEN_CODE_AGENTS_FILE));
  if (agents !== undefined) files.push({ path: OPEN_CODE_AGENTS_FILE, content: agents });
  let totalBytes = Buffer.byteLength(agents ?? "");
  const visit = async (source: string, path: string): Promise<void> => {
    const stats = await lstat(source).catch((error: unknown) => {
      if (isMissingFile(error)) return undefined;
      throw error;
    });
    if (!stats) {
      if (path) throw new Error(`instance file '${path}' disappeared`);
      return;
    }
    if (stats.isSymbolicLink()) throw new Error(`instance .opencode/${path} must not be a symlink`);
    if (
      path &&
      (!OPEN_CODE_RESOURCE_DIRECTORY_SET.has(path.split("/")[0] ?? "") ||
        !isSafeOpenCodeProjectFilePath(path))
    ) {
      throw new Error(`instance .opencode/${path} is not a supported config path`);
    }
    if (stats.isDirectory()) {
      for (const name of (await readdir(source)).sort()) {
        await visit(join(source, name), path ? `${path}/${name}` : name);
      }
    } else {
      if (!path.includes("/"))
        throw new Error("instance .opencode files must be inside a supported config directory");
      const content = await readOptionalTextFile(source);
      if (content === undefined) throw new Error(`instance file '${path}' disappeared`);
      totalBytes += Buffer.byteLength(content);
      if (files.length >= MAX_PROJECT_FILES || totalBytes > MAX_PROJECT_BYTES) {
        throw new Error("instance OpenCode project files exceed snapshot limits");
      }
      files.push({ path, content });
    }
  };
  await visit(join(root, ".opencode"), "");
  return {
    settings: settings as JsonObject,
    files: files.sort((left, right) => left.path.localeCompare(right.path)),
  };
}

async function readOptionalTextFile(path: string): Promise<string | undefined> {
  const stats = await lstat(path).catch((error: unknown) => {
    if (isMissingFile(error)) return undefined;
    throw error;
  });
  if (!stats) return undefined;
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`instance ${path} must be a regular file, not a symlink`);
  }
  if (stats.size > MAX_CONFIG_FILE_BYTES) {
    throw new Error(`instance ${path} exceeds ${MAX_CONFIG_FILE_BYTES} bytes`);
  }
  const bytes = await readFile(path);
  if (bytes.includes(0)) throw new Error(`instance ${path} must be a text file`);
  return bytes.toString("utf8");
}

export function normalizeOpenCodeInstructionPaths(
  value: unknown,
  files: readonly OpenCodeProjectFile[],
): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error("instance opencode.json instructions must be an array of strings");
  }
  const available = new Set(files.map(({ path }) => path));
  return (value as string[]).map((entry) => {
    const path = entry.replace(/^\.\//, "");
    const staged = path.startsWith(".opencode/") ? path.slice(".opencode/".length) : path;
    if (
      (path !== OPEN_CODE_AGENTS_FILE && !path.startsWith(".opencode/")) ||
      !isSafeOpenCodeProjectFilePath(staged)
    ) {
      throw new Error(
        `instance instruction path '${entry}' must stay inside AGENTS.md or .opencode`,
      );
    }
    if (!/[*?[\]{}]/.test(staged) && !available.has(staged)) {
      throw new Error(
        `instance instruction file '${entry}' is not present in the selected profile`,
      );
    }
    return `./${staged}`;
  });
}

export function isSafeOpenCodeProjectFilePath(path: string): boolean {
  const segments = path.split("/");
  return (
    !path.includes("\\") &&
    !segments.some((segment) => segment === "" || segment === "." || segment === "..") &&
    (path === OPEN_CODE_AGENTS_FILE || OPEN_CODE_RESOURCE_DIRECTORY_SET.has(segments[0] ?? ""))
  );
}
