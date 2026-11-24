export type LoopWriteResult = void | PromiseLike<void>;

export interface CycleAdmissionLease {
  release(): LoopWriteResult;
}

/** Prevents more than one coordinator loop from owning an instance. */
export interface CycleAdmission {
  acquire(signal: AbortSignal): Promise<CycleAdmissionLease | null>;
}
