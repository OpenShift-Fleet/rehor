import type { WorkPreflightResult } from "./work-preflight.js";

export type SessionCompletion = "gone" | "not-created" | "unknown";
export type SessionConfirmation = Exclude<SessionCompletion, "unknown">;

export type DispatchResult =
  | { status: "started"; completion: Promise<SessionCompletion>; confirm: (confirmation: SessionConfirmation) => boolean }
  | { status: "busy" | "shutdown" | "skip" | "error" | "no-scripts" };

/**
 * In-memory reservations for one dispatcher process. The caller runs and
 * serializes work preflight separately, before passing its result here.
 *
 * The callback reports "gone" only after confirmed sandbox deletion, or
 * "not-created" only after a definite pre-admission failure. An accepted
 * delete, timeout, or other ambiguous outcome is "unknown". Rejections and
 * invalid callback results also retain the reservation as unknown. Neither
 * payloads nor errors are logged by this dispatcher.
 *
 * Reservations are process-local; callers must reconcile remote state after a
 * restart. drain/shutdown wait for retained reservations to be confirmed too.
 */
export class SessionDispatcher {
  private readonly inFlight = new Map<string, {
    phase: "running" | "retained";
    released: Promise<void>;
    release: () => void;
  }>();
  private closed = false;

  get size(): number {
    return this.inFlight.size;
  }

  isInFlight(agent: string): boolean {
    return this.inFlight.has(agent);
  }

  status(agent: string): "running" | "retained" | undefined {
    return this.inFlight.get(agent)?.phase;
  }

  dispatch(
    agent: string,
    preflight: WorkPreflightResult,
    run: (prompt: string) => SessionCompletion | Promise<SessionCompletion>,
  ): DispatchResult {
    if (this.closed) return { status: "shutdown" };
    if (preflight.action !== "start") return { status: preflight.action };
    if (this.inFlight.has(agent)) return { status: "busy" };

    // Defer user code until after the reservation is visible, even for
    // synchronous callbacks and reentrant dispatches.
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const reservation = { phase: "running" as "running" | "retained", released, release };
    this.inFlight.set(agent, reservation);
    const completion: Promise<SessionCompletion> = Promise.resolve()
      .then(() => run(preflight.prompt))
      .then<SessionCompletion, SessionCompletion>(
        (result) => result === "gone" || result === "not-created" ? result : "unknown",
        () => "unknown",
      )
      .then((status): SessionCompletion => {
        if (status === "unknown") reservation.phase = "retained";
        else {
          this.inFlight.delete(agent);
          reservation.release();
        }
        return status;
      });
    // Bind confirmation to this reservation so stale handles cannot release a
    // later session for the same agent.
    const confirm = (confirmation: SessionConfirmation): boolean => {
      if (confirmation !== "gone" && confirmation !== "not-created") return false;
      if (this.inFlight.get(agent) !== reservation || reservation.phase !== "retained") return false;
      this.inFlight.delete(agent);
      reservation.release();
      return true;
    };
    return { status: "started", completion, confirm };
  }

  /** Wait until all currently running and subsequently admitted sessions settle. */
  async drain(): Promise<void> {
    while (this.inFlight.size) await Promise.all([...this.inFlight.values()].map((entry) => entry.released));
  }

  /** Stop admissions synchronously, then wait for all reserved sessions. */
  shutdown(): Promise<void> {
    this.closed = true;
    return this.drain();
  }
}
