import { normalizeReplyText } from "@/lib/reply-text";
import type { EvalCase } from "./dataset";

/** What one run of one case produced: from a canned mock output, or from a live model. */
export interface EvalObservation {
  output: string;
  /** The tool the model called first, or null. */
  toolCalled: string | null;
  completionTokens: number;
}

/** The failed checks of one case. An empty list is a pass. */
export function gradeEvalCase(testCase: EvalCase, observed: EvalObservation): string[] {
  const failures: string[] = [];
  const output = normalizeReplyText(observed.output);
  const { assertions } = testCase;

  if (testCase.expectedTool === "web_search" && observed.toolCalled !== "web_search") {
    failures.push(`expected web_search, got ${observed.toolCalled ?? "no tool"}`);
  } else if (testCase.expectedTool === "none" && observed.toolCalled !== null) {
    failures.push(`expected no tool, got ${observed.toolCalled}`);
  }
  for (const pattern of assertions.mustIncludePatterns ?? []) {
    if (!pattern.test(output)) failures.push(`missing ${pattern}`);
  }
  for (const pattern of assertions.mustNotIncludePatterns ?? []) {
    if (pattern.test(output)) failures.push(`must not match ${pattern}`);
  }
  if (assertions.shouldCite && !/\[\d+\]/.test(output)) failures.push("expected a citation like [1]");
  if (assertions.shouldCite === false && /\[\d+\]/.test(output)) failures.push("expected no citation");
  if (assertions.maxCompletionTokens && observed.completionTokens > assertions.maxCompletionTokens) {
    failures.push(`used ${observed.completionTokens} output tokens, limit ${assertions.maxCompletionTokens}`);
  }
  return failures;
}
