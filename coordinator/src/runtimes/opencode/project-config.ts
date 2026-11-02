import { lstat, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isAlias, isMap, isNode, isScalar, parseDocument, visit } from "yaml";

import { type InstructionAssemblyRequest, resolveWorkflowDir } from "../../instructions";
import { isMissingFile } from "../../utils";
import { asObject } from "../shared";
import { OPEN_CODE_AGENTS_FILE, OPEN_CODE_RESOURCE_DIRECTORY_SET } from "./constants";
import { validateNativeAgent, validateNativeCommand } from "./native-definitions";
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
      throw new Error(
        `instance .opencode/${path} is not a native V2 config path; use agents, commands, plugins, or skills`,
      );
    }
    if (stats.isDirectory()) {
      for (const name of (await readdir(source)).sort()) {
        if (isGeneratedPythonArtifact(name)) continue;
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
      validateOpenCodeProjectFile({ path, content });
      files.push({ path, content });
    }
  };
  await visit(join(root, ".opencode"), "");
  return {
    settings: settings as JsonObject,
    files: files.sort((left, right) => left.path.localeCompare(right.path)),
  };
}

/**
 * CPython writes bytecode caches (e.g. `__pycache__/<module>.cpython-312.pyc`)
 * next to executed skill helpers, including inside synced instance profiles.
 * They are never legitimate OpenCode project config files, so skip them during
 * directory traversal instead of failing the prepare phase on binary content.
 */
function isGeneratedPythonArtifact(name: string): boolean {
  return name === "__pycache__" || name.endsWith(".pyc") || name.endsWith(".pyo");
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

/** Validate without rewriting the original Markdown, including its body and line endings. */
export function validateOpenCodeProjectFile(file: OpenCodeProjectFile): void {
  const path = `.opencode/${file.path}`;
  const invalid = (message: string): never => {
    throw new Error(`${path}: ${message}`);
  };
  if (!isSafeOpenCodeProjectFilePath(file.path)) invalid("not a canonical native V2 resource path");
  if (typeof file.content !== "string" || file.content.includes("\0"))
    invalid("must be a text file");
  if (Buffer.byteLength(file.content) > MAX_CONFIG_FILE_BYTES)
    invalid("exceeds definition size limit");
  if (
    !file.path.endsWith(".md") ||
    (!file.path.startsWith("agents/") && !file.path.startsWith("commands/"))
  )
    return;
  try {
    const text = file.content.startsWith("\uFEFF") ? file.content.slice(1) : file.content;
    const lines = text.split(/\r?\n/);
    let body = text;
    let data: Record<string, unknown> = {};
    if (lines[0].startsWith("---")) {
      if (lines[0] !== "---") invalid("frontmatter must use a plain --- YAML delimiter");
      const end = lines.indexOf("---", 1);
      if (end < 0) invalid("unterminated YAML frontmatter");
      const document = parseDocument(lines.slice(1, end).join("\n"), {
        version: "1.2",
        schema: "core",
        // Reject ambiguous plain scalars rather than disagree with upstream's
        // YAML resolver (e.g. numeric underscores, timestamps, yes/no).
        compat: "yaml-1.1",
        customTags: ["timestamp"],
        strict: true,
        uniqueKeys: true,
        merge: false,
        resolveKnownTags: false,
      });
      if (document.errors.length || document.warnings.length) invalid("invalid YAML frontmatter");
      if (document.directives?.yaml.explicit || document.directives?.docEnd)
        invalid("YAML directives/document markers are not supported");
      let nodes = 0;
      visit(document, (_key, node, parents) => {
        if (++nodes > 20000 || parents.length > 64) invalid("frontmatter exceeds parsing limits");
        if (isAlias(node) || (isNode(node) && (node.tag || ("anchor" in node && node.anchor))))
          invalid("YAML tags, anchors and aliases are not supported");
        if (isMap(node))
          for (const pair of node.items) {
            if (
              !isScalar(pair.key) ||
              typeof pair.key.value !== "string" ||
              pair.key.value === "<<"
            )
              invalid("frontmatter keys must be strings; YAML merges are not supported");
          }
      });
      const value: unknown = document.contents === null ? {} : document.toJS({ maxAliasCount: 0 });
      if (!asObject(value))
        invalid("frontmatter must be a native mapping, not a scalar or sequence");
      data = value as Record<string, unknown>;
      body = lines.slice(end + 1).join("\n");
    }
    if (file.path.startsWith("agents/")) {
      validateNativeAgent(data, path);
      validateNativeAgent({ ...data, system: body.trim() }, path);
    } else {
      if (data.template !== undefined && typeof data.template !== "string")
        invalid("template must be a string");
      validateNativeCommand({ ...data, template: body.trim() }, path);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`${path}:`)) throw error;
    invalid(error instanceof Error ? error.message : "invalid native frontmatter");
  }
}
