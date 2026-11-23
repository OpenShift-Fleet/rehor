/**
 * Warning plumbing for the obsint preflights' best-effort cleanup paths —
 * the port of the Python scripts' `print(f"WARN: ...", file=sys.stderr)`
 * lines. The Python wrote cleanup warnings to stderr where only operators
 * saw them; the engine has no stderr channel for preflight output, so
 * tolerated per-entry failures are appended to the result content instead
 * (the cycle-report surface) while the run continues.
 */

/** The message of an unknown thrown value. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Append the collected warning lines to a result content. No-op without
 * warnings, so clean runs keep the Python output byte-for-byte.
 */
export function appendWarnings(content: string, warnings: readonly string[]): string {
  if (warnings.length === 0) return content;
  const lines = warnings.map((warning) => `WARN: ${warning}`);
  return `${content}\n${lines.join("\n")}`;
}
