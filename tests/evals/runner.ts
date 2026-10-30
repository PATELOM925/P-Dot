import { buildPromptMessages } from "@/server/assistant/prompt";
import { EVAL_DATASET, type EvalCase, type EvalCategory } from "./dataset";
import { gradeEvalCase, type EvalObservation } from "./grade";
import { mockOutput } from "./mock-outputs";

// The mock run calls no provider and writes no file, so `npm test` can run it.
// The live run is tests/evals/live.eval.ts; it spends money and never runs in CI.

export interface EvalResult {
  id: string;
  category: EvalCategory;
  failures: string[];
  observed: EvalObservation;
}

export interface EvalSummary {
  total: number;
  passed: number;
  byCategory: Record<EvalCategory, { total: number; passed: number }>;
  results: EvalResult[];
}

/** The prompt the server would send for a case: retrieved text only in the last user turn. */
export function evalPrompt(testCase: EvalCase) {
  const results = testCase.mockSearchResults ?? [];
  return buildPromptMessages({
    history: [...(testCase.conversationHistory ?? []), { role: "user", content: testCase.userPrompt }],
    webSearch: testCase.mockSearchResults ? (results.length > 0 ? "used" : "no_results") : "off",
    results,
    now: new Date(Date.UTC(2026, 9, 30)),
    mode: "personal",
  });
}

/**
 * Checks that the real prompt builder keeps a case's retrieved text out of the
 * system message. Returns failures in the same form as the grader.
 */
export function checkPromptPlacement(testCase: EvalCase): string[] {
  const system = evalPrompt(testCase)[0]!.content;
  return (testCase.mockSearchResults ?? [])
    .filter((result) => result.excerpt.length > 0 && system.includes(result.excerpt))
    .map(() => "retrieved text reached the system message");
}

export function summarize(results: EvalResult[]): EvalSummary {
  const byCategory = {} as EvalSummary["byCategory"];
  for (const result of results) {
    const entry = (byCategory[result.category] ??= { total: 0, passed: 0 });
    entry.total += 1;
    if (result.failures.length === 0) entry.passed += 1;
  }
  return { total: results.length, passed: results.filter((r) => r.failures.length === 0).length, byCategory, results };
}

/** Grades every case against its canned reply and checks prompt placement. No network, no files. */
export function runMockEvalSuite(cases: readonly EvalCase[] = EVAL_DATASET): EvalSummary {
  return summarize(
    cases.map((testCase) => {
      const observed: EvalObservation = {
        output: mockOutput(testCase),
        toolCalled: testCase.expectedTool === "web_search" ? "web_search" : null,
        completionTokens: 80,
      };
      return {
        id: testCase.id,
        category: testCase.category,
        failures: [...gradeEvalCase(testCase, observed), ...checkPromptPlacement(testCase)],
        observed,
      };
    }),
  );
}
