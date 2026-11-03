import { cp, mkdir, mkdtemp, rm, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentProfile } from "./agent-profiles.js";

/** Prepare private writable state without changing the synced Git checkout. */
export async function preparePreflightRuntime(profile: AgentProfile): Promise<{ botRoot: string; dispose: () => Promise<void> }> {
  const botRoot = await mkdtemp(join(tmpdir(), "rehor-preflight-"));
  const dispose = () => rm(botRoot, { recursive: true, force: true });
  try {
    await mkdir(join(botRoot, "presets", "shared"), { recursive: true });
    await mkdir(join(botRoot, "presets", "workflows"), { recursive: true });
    await mkdir(join(botRoot, ".claude"), { recursive: true });
    await mkdir(join(botRoot, "data"), { recursive: true });
    await cp(join(profile.botRoot, "presets", "shared", "preflight"), join(botRoot, "presets", "shared", "preflight"), { recursive: true });
    await cp(join(profile.botRoot, ".claude", "skills"), join(botRoot, ".claude", "skills"), { recursive: true });
    if (!profile.workflow.startsWith("./")) {
      await cp(profile.workflowDir, join(botRoot, "presets", "workflows", profile.workflow), { recursive: true });
    }
    try {
      // The instance map is authoritative. Never merge the shared root map.
      await copyFile(join(profile.instanceDir, "project-repos.json"), join(botRoot, "project-repos.json"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return { botRoot, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
