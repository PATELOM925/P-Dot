// The rules for the landing page's simulated agent run, kept free of React so
// they can be tested. A run reveals one step at a time. It stops at the step that
// needs the user, and carries on only after the user approves or skips it.

export type ApprovalStatus = "waiting" | "approved" | "skipped";

export type StepPhase = "queued" | "working" | "done" | "approval" | "approved" | "skipped";

interface StepLike {
  state: "done" | "approval" | "next";
}

/** Where the step that needs the user sits, or -1 when a run has none. */
export function approvalIndex(steps: readonly StepLike[]): number {
  return steps.findIndex((step) => step.state === "approval");
}

/** How many steps a run completes before it stops: up to the approval step while waiting, all of them after. */
export function runTarget(steps: readonly StepLike[], status: ApprovalStatus): number {
  const approval = approvalIndex(steps);
  return status === "waiting" && approval >= 0 ? approval : steps.length;
}

/** What one step looks like when `revealed` steps have finished. */
export function stepPhase(steps: readonly StepLike[], index: number, revealed: number, status: ApprovalStatus): StepPhase {
  const approval = approvalIndex(steps);
  const target = runTarget(steps, status);

  if (index === approval && revealed >= approval) {
    if (status === "approved") return "approved";
    if (status === "skipped") return "skipped";
    return "approval";
  }
  if (index < revealed) return "done";
  if (index === revealed && revealed < target) return "working";
  return "queued";
}

/** True when the run has nothing more to reveal until the user acts, or has finished. */
export function isSettled(steps: readonly StepLike[], revealed: number, status: ApprovalStatus): boolean {
  return revealed >= runTarget(steps, status);
}

/** The step count to resume from once the user decides on the approval step. */
export function revealedAfterDecision(steps: readonly StepLike[], revealed: number): number {
  const approval = approvalIndex(steps);
  return approval < 0 ? revealed : Math.max(revealed, approval + 1);
}

/** One line under the task that says what the run is doing. */
export function runStatusLine(steps: readonly StepLike[], revealed: number, status: ApprovalStatus): string {
  if (!isSettled(steps, revealed, status)) return `Working on step ${Math.min(revealed + 1, steps.length)} of ${steps.length}…`;
  if (status === "waiting" && approvalIndex(steps) >= 0) return "Paused: waiting for your approval";
  return status === "skipped" ? "Finished. You skipped one step." : "Finished. Every step was approved.";
}

/** Share of the run that is finished, from 0 to 1. */
export function runProgress(steps: readonly StepLike[], revealed: number): number {
  return steps.length === 0 ? 0 : Math.min(1, revealed / steps.length);
}
