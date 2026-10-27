import { type CoordinatorLoopResult, LoopStopReason } from "./loop";

export function coordinatorExitCode(result: CoordinatorLoopResult<unknown>, once: boolean): number {
  if (result.stopReason === LoopStopReason.Failed) return 1;
  if (once && (result.failures > 0 || result.stopReason === LoopStopReason.AdmissionDenied))
    return 1;
  return 0;
}
