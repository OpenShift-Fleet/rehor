import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";

import { OpenCodeReadinessError } from "./readiness";

/** Runner-owned setup error: only validated filesystem metadata is retained. */
export class OpenCodeWorkspaceOwnershipError extends OpenCodeReadinessError {
  constructor(
    readonly directory: string,
    readonly actualUid: number,
    readonly expectedUid: number,
  ) {
    super(
      `OpenCode worktree path ${directory} is owned by UID ${actualUid}, expected ${expectedUid}`,
      true,
    );
    this.name = "OpenCodeWorkspaceOwnershipError";
  }
}

export async function resolveApprovedWorkspace(
  directory: string,
  workspaceRoot: string | undefined,
  workspaceOwnerUid: number | undefined,
): Promise<string> {
  if (!isAbsolute(directory)) {
    throw new OpenCodeReadinessError(
      `OpenCode worktree path must be absolute, got ${directory}`,
      true,
    );
  }
  if (!workspaceRoot) {
    throw new OpenCodeReadinessError("OpenCode workspace root is required", true);
  }
  if (!isAbsolute(workspaceRoot)) {
    throw new OpenCodeReadinessError(
      `OpenCode workspace root must be absolute, got ${workspaceRoot}`,
      true,
    );
  }

  let canonicalRoot: string;
  let canonicalDirectory: string;
  try {
    [canonicalRoot, canonicalDirectory] = await Promise.all([
      realpath(workspaceRoot),
      realpath(directory),
    ]);
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new OpenCodeReadinessError(
      `OpenCode worktree path must resolve to an accessible directory${detail}`,
      true,
    );
  }

  const relativeDirectory = relative(canonicalRoot, canonicalDirectory);
  if (
    relativeDirectory === ".." ||
    relativeDirectory.startsWith(`..${sep}`) ||
    isAbsolute(relativeDirectory)
  ) {
    throw new OpenCodeReadinessError(
      `OpenCode worktree path ${canonicalDirectory} is outside approved workspace root ${canonicalRoot}`,
      true,
    );
  }

  let directoryStats: Awaited<ReturnType<typeof stat>>;
  try {
    directoryStats = await stat(canonicalDirectory);
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : "";
    throw new OpenCodeReadinessError(`OpenCode worktree path must be stat-able${detail}`, true);
  }
  if (!directoryStats.isDirectory()) {
    throw new OpenCodeReadinessError(
      `OpenCode worktree path is not a directory: ${canonicalDirectory}`,
      true,
    );
  }

  const expectedOwnerUid = workspaceOwnerUid ?? currentUserUid();
  if (expectedOwnerUid !== undefined && directoryStats.uid !== expectedOwnerUid) {
    throw new OpenCodeWorkspaceOwnershipError(
      canonicalDirectory,
      directoryStats.uid,
      expectedOwnerUid,
    );
  }
  return canonicalDirectory;
}

function currentUserUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}
