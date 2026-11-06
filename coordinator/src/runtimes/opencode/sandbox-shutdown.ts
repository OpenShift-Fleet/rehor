import type { ChildProcess } from "node:child_process";
import { OpenCodeProcessLeakError } from "./process-leak-error";

interface SandboxShutdownOptions {
  child: ChildProcess;
  shutdownTimeoutMs: number;
  killVerificationTimeoutMs: number;
  childError: Error | undefined;
  isExited: () => boolean;
  isSpawnFailed: () => boolean;
  markTermSent: () => void;
  cleanupOutput: () => void;
  cleanupVerifiedChild: () => Promise<void>;
}

export function isBrokenPipe(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EPIPE";
}

export async function shutdownSandboxChild(options: SandboxShutdownOptions): Promise<void> {
  const { child } = options;
  try {
    await stopSandboxChild(options);
  } finally {
    options.cleanupOutput();
    // Even an unverified child or its descendants can retain these pipes.
    // Release our handles so the one-shot runner can exit and the outer
    // dispatcher can delete the sandbox. This does not imply termination.
    child.stdin?.destroy();
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.unref();
    // Keep an unverified child for a later stop attempt; never signal a
    // PID again after observing its exit (it may have been reused).
    if (options.isExited() || options.isSpawnFailed()) await options.cleanupVerifiedChild();
  }
}

function stopSandboxChild(options: SandboxShutdownOptions): Promise<void> {
  const { child } = options;
  // This only verifies the direct leader. The outer dispatcher must delete
  // and confirm sandbox removal to clean up any descendants.
  return new Promise((resolve, reject) => {
    let graceTimer: NodeJS.Timeout | undefined;
    let verificationTimer: NodeJS.Timeout | undefined;
    let settled = false;
    let shutdownError = options.childError;
    const recordError = (error: unknown): void => {
      const actual = error instanceof Error ? error : new Error(String(error));
      if (!shutdownError) shutdownError = actual;
      else if (actual !== shutdownError)
        shutdownError = new AggregateError(
          [shutdownError, actual],
          `${shutdownError.message}; ${actual.message}`,
        );
    };
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (graceTimer) clearTimeout(graceTimer);
      if (verificationTimer) clearTimeout(verificationTimer);
      child.removeListener("exit", onExit);
      child.removeListener("error", onError);
      child.stdin?.removeListener("error", onStdinError);
      if (error && shutdownError && error !== shutdownError) {
        reject(
          new AggregateError([shutdownError, error], `${shutdownError.message}; ${error.message}`),
        );
      } else if (error ?? shutdownError) reject(error ?? shutdownError);
      else resolve();
    };
    const onExit = (): void => finish();
    const onError = (error: Error): void => {
      recordError(error);
      if (options.isSpawnFailed()) finish();
    };
    const onStdinError = (error: Error): void => {
      if (!options.isExited() || !isBrokenPipe(error)) recordError(error);
    };
    const signal = (name: NodeJS.Signals): void => {
      if (options.isExited() || options.isSpawnFailed() || !child.pid || child.pid <= 0) return;
      try {
        if (!child.kill(name)) recordError(new Error(`OpenCode child ${name} signal failed`));
      } catch (error) {
        recordError(error);
      }
    };
    child.once("exit", onExit);
    child.on("error", onError);
    child.stdin?.on("error", onStdinError);
    options.markTermSent();
    try {
      if (!child.stdin?.destroyed) child.stdin?.end();
    } catch (error) {
      recordError(error);
    }
    if (options.isExited() || options.isSpawnFailed()) {
      finish();
      return;
    }
    signal("SIGTERM");
    if (settled) return;
    graceTimer = setTimeout(() => {
      if (options.isExited() || options.isSpawnFailed()) return finish();
      signal("SIGKILL");
      if (settled) return;
      verificationTimer = setTimeout(() => {
        if (options.isExited() || options.isSpawnFailed()) return finish();
        finish(new OpenCodeProcessLeakError("OpenCode child exit was not verified after SIGKILL"));
      }, options.killVerificationTimeoutMs);
    }, options.shutdownTimeoutMs);
  });
}
