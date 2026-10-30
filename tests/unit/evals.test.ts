import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EVAL_DATASET } from "../evals/dataset";
import { gradeEvalCase } from "../evals/grade";
import { checkPromptPlacement, runMockEvalSuite } from "../evals/runner";

const EVALS = join(__dirname, "..", "evals");

describe("eval dataset", () => {
  it("has 50 cases with unique IDs in 5 groups", () => {
    expect(EVAL_DATASET).toHaveLength(50);
    expect(new Set(EVAL_DATASET.map((c) => c.id)).size).toBe(50);
    expect(new Set(EVAL_DATASET.map((c) => c.category))).toEqual(
      new Set(["tool_decision", "citation_grounding", "safety_injection", "context_formatting", "budget_cost"]),
    );
  });

  it("has 8 search and 7 no-search tool decision cases", () => {
    const tool = EVAL_DATASET.filter((c) => c.category === "tool_decision");
    expect(tool.filter((c) => c.expectedTool === "web_search")).toHaveLength(8);
    expect(tool.filter((c) => c.expectedTool === "none")).toHaveLength(7);
  });
});

describe("mock eval run", () => {
  it("passes every case with the canned replies and the real prompt builder", () => {
    const summary = runMockEvalSuite();
    const failed = summary.results.filter((r) => r.failures.length > 0).map((r) => `${r.id}: ${r.failures.join("; ")}`);
    expect(failed).toEqual([]);
    expect(summary.passed).toBe(50);
  });

  it("fails a reply that breaks the checks, so a pass means something", () => {
    const cite = EVAL_DATASET.find((c) => c.assertions.shouldCite)!;
    expect(gradeEvalCase(cite, { output: "No sources here.", toolCalled: null, completionTokens: 9_999 })).not.toEqual([]);
    const capped = EVAL_DATASET.find((c) => c.assertions.maxCompletionTokens)!;
    expect(gradeEvalCase(capped, { output: "x", toolCalled: null, completionTokens: 10_000 }).join()).toContain("output tokens");
  });

  it("keeps the injected text of every safety case out of the system message", () => {
    for (const testCase of EVAL_DATASET.filter((c) => c.mockSearchResults?.length)) {
      expect(checkPromptPlacement(testCase), testCase.id).toEqual([]);
    }
  });

  it("writes no file: only the live run, outside npm test, writes a report", () => {
    for (const file of readdirSync(EVALS).filter((name) => name.endsWith(".ts") && name !== "live.eval.ts")) {
      const source = readFileSync(join(EVALS, file), "utf8");
      expect(source, file).not.toMatch(/node:fs|writeFile|mkdir/);
    }
  });

  it("keeps the live run out of npm test", () => {
    const config = readFileSync(join(__dirname, "..", "..", "vitest.config.ts"), "utf8");
    expect(config).not.toContain("tests/evals");
    expect(readFileSync(join(EVALS, "live.eval.ts"), "utf8")).toContain('process.env.PDOT_EVAL_LIVE === "1"');
  });
});
