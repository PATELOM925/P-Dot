import { describe, expect, it } from "vitest";
import { USE_CASES } from "@/features/landing/DynamicAgentCard";
import {
  approvalIndex,
  isSettled,
  revealedAfterDecision,
  runProgress,
  runStatusLine,
  runTarget,
  stepPhase,
} from "@/features/landing/agent-run";

const steps = USE_CASES[0]!.steps; // 5 steps, approval at index 3

describe("simulated agent run", () => {
  it("stops at the step that needs the user and carries on after a decision", () => {
    expect(approvalIndex(steps)).toBe(3);
    expect(runTarget(steps, "waiting")).toBe(3);
    expect(runTarget(steps, "approved")).toBe(5);
    expect(runTarget(steps, "skipped")).toBe(5);
  });

  it("walks every step through queued, working and done, in order", () => {
    const phases = (revealed: number) => steps.map((_, index) => stepPhase(steps, index, revealed, "waiting"));
    expect(phases(0)).toEqual(["working", "queued", "queued", "queued", "queued"]);
    expect(phases(1)).toEqual(["done", "working", "queued", "queued", "queued"]);
    expect(phases(2)).toEqual(["done", "done", "working", "queued", "queued"]);
    // Reached the approval step: it asks, nothing is working, and the steps after it wait.
    expect(phases(3)).toEqual(["done", "done", "done", "approval", "queued"]);
  });

  it("never runs past the approval step until the user decides", () => {
    expect(isSettled(steps, 3, "waiting")).toBe(true);
    expect(isSettled(steps, 2, "waiting")).toBe(false);
    expect(stepPhase(steps, 4, 3, "waiting")).toBe("queued");
  });

  it("continues after Approve, finishing the steps after it", () => {
    const after = revealedAfterDecision(steps, 3);
    expect(after).toBe(4);
    expect(steps.map((_, index) => stepPhase(steps, index, after, "approved"))).toEqual([
      "done",
      "done",
      "done",
      "approved",
      "working",
    ]);
    expect(isSettled(steps, 5, "approved")).toBe(true);
    expect(steps.map((_, index) => stepPhase(steps, index, 5, "approved"))).toEqual(["done", "done", "done", "approved", "done"]);
  });

  it("marks the step as skipped after Skip and still finishes the run", () => {
    expect(stepPhase(steps, 3, 4, "skipped")).toBe("skipped");
    expect(isSettled(steps, 5, "skipped")).toBe(true);
  });

  it("describes progress and status in plain words", () => {
    expect(runStatusLine(steps, 1, "waiting")).toBe("Working on step 2 of 5…");
    expect(runStatusLine(steps, 3, "waiting")).toBe("Paused: waiting for your approval");
    expect(runStatusLine(steps, 5, "approved")).toBe("Finished. Every step was approved.");
    expect(runStatusLine(steps, 5, "skipped")).toBe("Finished. You skipped one step.");
    expect(runProgress(steps, 0)).toBe(0);
    expect(runProgress(steps, 5)).toBe(1);
    expect(runProgress(steps, 99)).toBe(1);
  });

  it("works for every scenario on the landing page", () => {
    for (const useCase of USE_CASES) {
      const a = approvalIndex(useCase.steps);
      expect(a).toBeGreaterThanOrEqual(0);
      expect(stepPhase(useCase.steps, a, a, "waiting")).toBe("approval");
      expect(runTarget(useCase.steps, "approved")).toBe(useCase.steps.length);
    }
  });
});
