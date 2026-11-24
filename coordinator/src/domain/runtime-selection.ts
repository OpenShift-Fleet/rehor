export const OPENCODE_RUNTIME_ID = "opencode";

export function isOpenCodeRuntime(runtimeId: string | undefined): boolean {
  return runtimeId === OPENCODE_RUNTIME_ID;
}
