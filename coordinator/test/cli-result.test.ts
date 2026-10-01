import { describe, expect, it } from "vitest";

import { coordinatorExitCode } from "../src/cli-result";
import { LoopStopReason } from "../src/loop";

const result = {
  stopReason: LoopStopReason.MaxCycles,
  cycles: 1,
  results: [],
  failures: 1,
};

describe("coordinator CLI exit code", () => {
  it("fails a one-shot run when the cycle failed even if the loop reached max_cycles", () => {
    expect(coordinatorExitCode(result, true)).toBe(1);
  });

  it("keeps an expected no-work one-shot successful", () => {
    expect(coordinatorExitCode({ ...result, failures: 0 }, true)).toBe(0);
  });
});
