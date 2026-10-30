import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatSearchResults } from "@/server/assistant/prompt";
import { SUPER } from "@/server/assistant/tiers";
import { TOOLS, toToolDefinition } from "@/server/assistant/tools";
import { createNebiusProvider, type ChatMessage, type ToolCall } from "@/server/providers/model";
import { EVAL_DATASET } from "./dataset";
import { gradeEvalCase } from "./grade";
import { evalPrompt, summarize, type EvalResult } from "./runner";

// LIVE EVAL: THIS SPENDS MONEY ON NEBIUS. It never runs in `npm test` or CI:
// only `npm run eval:live` runs it, and only with PDOT_EVAL_LIVE=1 set.
// It makes up to 2 calls for each of the 50 cases (at most 512 output tokens
// each) on NEBIUS_EVAL_MODEL, default Nemotron 3 Super: about $0.15 at most.
// It calls no search provider: a web_search call gets the case's fixed results.
// It reads NEBIUS_API_KEY from the environment only, never from a file, and
// goes around the app's spend guard, so watch the Nebius dashboard.

const LIVE = process.env.PDOT_EVAL_LIVE === "1";
const MAX_OUTPUT_TOKENS = 512;

describe.skipIf(!LIVE)("live eval (spends money)", () => {
  it("runs the 50 cases on the live model", { timeout: 30 * 60_000 }, async () => {
    const apiKey = process.env.NEBIUS_API_KEY;
    expect(apiKey, "Set NEBIUS_API_KEY in the environment.").toBeTruthy();
    const model = process.env.NEBIUS_EVAL_MODEL ?? SUPER;
    console.warn(`\n*** LIVE EVAL: this spends money on Nebius (${model}). Stop now with Ctrl+C if you did not mean to. ***\n`);
    const provider = createNebiusProvider({
      apiKey: apiKey!,
      baseUrl: process.env.NEBIUS_BASE_URL ?? "https://api.tokenfactory.nebius.com/v1",
    });
    const tools = TOOLS.filter((tool) => tool.name === "web_search").map(toToolDefinition);

    const call = async (messages: ChatMessage[], withTools: boolean) => {
      let output = "";
      let calls: ToolCall[] = [];
      let completionTokens = 0;
      for await (const chunk of provider.stream(
        { model, messages, maxOutputTokens: MAX_OUTPUT_TOKENS, thinkingBudgetTokens: 0, timeoutMs: 60_000, ...(withTools ? { tools } : {}) },
        new AbortController().signal,
      )) {
        if (chunk.type === "text") output += chunk.text;
        if (chunk.type === "tool_calls") calls = chunk.calls;
        if (chunk.type === "finish") completionTokens = chunk.usage?.completionTokens ?? 0;
      }
      return { output, calls, completionTokens };
    };

    const results: EvalResult[] = [];
    for (const testCase of EVAL_DATASET) {
      const messages = evalPrompt({ ...testCase, mockSearchResults: undefined });
      const first = await call(messages, true);
      const toolCall = first.calls[0] ?? null;
      let observed = { output: first.output, toolCalled: toolCall?.name ?? null, completionTokens: first.completionTokens };
      if (toolCall) {
        const found = testCase.mockSearchResults ?? [];
        const second = await call(
          [
            ...messages,
            { role: "assistant", content: first.output, toolCalls: [toolCall] },
            { role: "tool", toolCallId: toolCall.id, content: found.length > 0 ? formatSearchResults(found) : "Web search found no usable results." },
          ],
          false,
        );
        observed = { ...observed, output: second.output, completionTokens: second.completionTokens };
      }
      results.push({ id: testCase.id, category: testCase.category, failures: gradeEvalCase(testCase, observed), observed });
    }

    const summary = summarize(results);
    // Untracked (.gitignore): eval output never goes into Git.
    const dir = join(process.cwd(), "tests", "evals", "reports");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `eval-live-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    writeFileSync(file, JSON.stringify({ model, ...summary }, null, 2));
    console.warn(`Live eval: ${summary.passed} of ${summary.total} passed. Report: ${file}`);
  });
});
