import { cp, copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentProfile } from "./agent-profiles.js";

export type PreflightRuntime = {
  botRoot: string;
  dispose: () => Promise<void>;
  /** Private-runtime preflight directories; symlinks are materialized copies. */
  preflightDirs: { workflow?: string; instance?: string };
};

/**
 * Prepare private writable state without changing the synced Git checkout.
 * Every copied path is dereferenced: Python (3.11+) resolves a script's real
 * path for sys.path[0], so a symlinked script would otherwise import shared
 * helpers from the checkout and read its project-repos.json and state file,
 * bypassing the instance map and runtime disposal.
 */
export async function preparePreflightRuntime(profile: AgentProfile): Promise<PreflightRuntime> {
  const botRoot = await mkdtemp(join(tmpdir(), "rehor-preflight-"));
  const dispose = () => rm(botRoot, { recursive: true, force: true });
  // Fail closed on dangling symlinks: a dereferencing copy of an unreadable
  // target must not silently produce a broken runtime.
  const materialize = (source: string, destination: string) => cp(source, destination, { recursive: true, dereference: true, errorOnExist: true });
  const preflightDirs: { workflow?: string; instance?: string } = {};
  try {
    await mkdir(join(botRoot, "presets", "shared"), { recursive: true });
    await mkdir(join(botRoot, "presets", "workflows"), { recursive: true });
    await mkdir(join(botRoot, ".claude"), { recursive: true });
    await mkdir(join(botRoot, "data"), { recursive: true });
    await materialize(join(profile.botRoot, "presets", "shared", "preflight"), join(botRoot, "presets", "shared", "preflight"));
    await materialize(join(profile.botRoot, ".claude", "skills"), join(botRoot, ".claude", "skills"));
    if (!profile.workflow.startsWith("./")) {
      await materialize(profile.workflowDir, join(botRoot, "presets", "workflows", profile.workflow));
      if (profile.workflowPreflightDir) preflightDirs.workflow = join(botRoot, "presets", "workflows", profile.workflow, "preflight");
    } else {
      // A relative workflow lives inside the instance directory; copying the
      // instance preserves the workflow/preflight structure beneath it.
      await materialize(profile.instanceDir, join(botRoot, "instance"));
      if (profile.workflowPreflightDir) preflightDirs.workflow = join(botRoot, "instance", profile.workflow.slice(2), "preflight");
      if (profile.instancePreflightDir) preflightDirs.instance = join(botRoot, "instance", "preflight");
    }
    if (!profile.workflow.startsWith("./") && profile.instancePreflightDir) {
      await materialize(profile.instanceDir, join(botRoot, "instance"));
      preflightDirs.instance = join(botRoot, "instance", "preflight");
    }
    try {
      // The instance map is authoritative. Never merge the shared root map.
      await copyFile(join(profile.instanceDir, "project-repos.json"), join(botRoot, "project-repos.json"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return { botRoot, dispose, preflightDirs };
  } catch (error) {
    await dispose();
    throw error;
  }
}
