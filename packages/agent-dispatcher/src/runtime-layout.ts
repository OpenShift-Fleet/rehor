import { posix } from "node:path";

export type RuntimeLayout = { kind: "legacy" } | { kind: "private"; source: string; parent: string };

/** Exact lexical paths only: no expansion, traversal, or trailing-slash aliases. */
export function isNormalizedAbsolutePath(value: string): boolean {
  return posix.isAbsolute(value) && value === posix.normalize(value) && (value === "/" || !value.endsWith("/"))
    && !/[\u0000-\u001f\u007f-\u009f*?\[\]{}\\!()$`~]/.test(value);
}

/** Both paths must already be normalized; compare whole path components. */
export function pathsOverlap(a: string, b: string): boolean {
  return a === "/" || b === "/" || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/** Deployment configuration, never sourced from an agent profile. */
export function readRuntimeLayout(env: NodeJS.ProcessEnv): RuntimeLayout {
  const layout = env.AGENT_DISPATCHER_RUNTIME_LAYOUT ?? "legacy";
  const source = env.AGENT_DISPATCHER_RUNTIME_SOURCE ?? "/opt/rehor/app";
  const parent = env.AGENT_DISPATCHER_RUNTIME_PARENT ?? "/tmp";
  if (layout === "legacy") {
    if (env.AGENT_DISPATCHER_RUNTIME_SOURCE !== undefined || env.AGENT_DISPATCHER_RUNTIME_PARENT !== undefined) throw new Error("Private runtime paths require private layout");
    return { kind: "legacy" };
  }
  if (layout !== "private" || !isNormalizedAbsolutePath(source) || !isNormalizedAbsolutePath(parent)
      || pathsOverlap(source, parent) || pathsOverlap("/opt/rehor", parent) || pathsOverlap("/opt/opencode", parent)) throw new Error("Invalid private runtime layout");
  return { kind: "private", source, parent };
}
