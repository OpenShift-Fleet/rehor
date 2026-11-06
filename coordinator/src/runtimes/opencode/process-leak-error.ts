import { providerDiagnostic } from "../../diagnostics";

/** The OpenCode shutdown target could not be verified after SIGKILL. */
export class OpenCodeProcessLeakError extends Error {
  constructor(message = "OpenCode process group remained alive after SIGKILL") {
    super(message);
    this.name = "OpenCodeProcessLeakError";
  }
}

/** Startup failed and its own shutdown attempt also failed. */
export class OpenCodeStartupCleanupError extends AggregateError {
  constructor(
    readonly startupError: unknown,
    readonly cleanupError: unknown,
  ) {
    super(
      [startupError, cleanupError],
      `OpenCode startup failed; shutdown failed: ${providerDiagnostic(cleanupError)}`,
      { cause: startupError },
    );
    this.name = "OpenCodeStartupCleanupError";
  }
}
