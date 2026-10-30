import { describe, expect, it, vi } from "vitest";
import { streamChatCompletion, type CompletionChunk, type NebiusSettings, type ToolDefinition } from "@/server/providers/nebius/client";
import { createToolMarkupFilter } from "@/server/providers/nebius/tool-markup";
import { checkToolCall } from "@/server/assistant/tools/registry";
import { CONNECTOR_TOOLS } from "@/server/assistant/tools/connectors";
import { collect, deltaChunk, finishChunk, sseEvent, streamFrom } from "../support/streams";

// Live, 2026-10-31: "Check if there are any open PRs on my github" with GitHub
// on. Nemotron 3 Super wrote its tool call as text in `content`, and the reply
// started with this markup. It must never reach the user.
const LEAKED = "</tool_call>\nnull\nnull\nnull\n</parameter>\n</function>\n</tool_call>\nI can check your pull requests.";

const QWEN_CALL =
  "<tool_call>\n<function=github_list_pull_requests>\n<parameter=repo>\nPATELOM925/P-Dot\n</parameter>\n<parameter=page>\nnull\n</parameter>\n</function>\n</tool_call>";

const prTool: ToolDefinition = {
  name: "github_list_pull_requests",
  description: "List open pull requests.",
  parameters: { type: "object", properties: { repo: { type: "string" } }, required: ["repo"] },
};
const daysTool: ToolDefinition = {
  name: "todoist_list_tasks",
  description: "List tasks.",
  parameters: { type: "object", properties: { days: { type: "integer" } }, required: ["days"] },
};

/** Pushes `text` in pieces of `size` characters. */
function run(text: string, size: number, tools: ToolDefinition[] = []) {
  const filter = createToolMarkupFilter(tools);
  let shown = "";
  for (let at = 0; at < text.length; at += size) shown += filter.push(text.slice(at, at + size));
  shown += filter.flush();
  return { shown, calls: filter.calls() };
}

describe("tool-call markup in reply text", () => {
  it.each([1, 2, 3, 7, 1000])("removes the exact leaked shape, in pieces of %i characters", (size) => {
    const { shown, calls } = run(LEAKED, size, [prTool]);
    expect(shown).toBe("I can check your pull requests.");
    expect(shown).not.toMatch(/tool_call|function|parameter|null/);
    expect(calls).toEqual([]);
  });

  it.each([1, 4, 1000])("turns a whole qwen block for an offered tool into a call, in pieces of %i characters", (size) => {
    const { shown, calls } = run(`Let me look.\n${QWEN_CALL}\n`, size, [prTool]);
    expect(shown).toBe("Let me look.\n");
    expect(calls).toEqual([{ id: "text_call_0", name: "github_list_pull_requests", arguments: '{"repo":"PATELOM925/P-Dot"}' }]);
  });

  it("parses the hermes JSON form and converts a value to the schema type", () => {
    expect(run('<tool_call>\n{"name": "github_list_pull_requests", "arguments": {"repo": "a/b"}}\n</tool_call>', 5, [prTool]).calls).toEqual([
      { id: "text_call_0", name: "github_list_pull_requests", arguments: '{"repo":"a/b"}' },
    ]);
    expect(run("<function=todoist_list_tasks>\n<parameter=days>\n3\n</parameter>\n</function>", 2, [daysTool]).calls[0]!.arguments).toBe('{"days":3}');
  });

  it("makes no call for a tool that is not offered, and shows none of its text", () => {
    const { shown, calls } = run(`Before ${QWEN_CALL} after`, 3, [daysTool]);
    expect(calls).toEqual([]);
    expect(shown).toBe("Before  after");
  });

  it("makes no call when no tool is offered (the last hop), and drops a block that never closes", () => {
    expect(run(QWEN_CALL, 3).calls).toEqual([]);
    expect(run("Hi\n<tool_call>\n<function=github_list_pull_requests>\n<parameter=repo>\na/b", 2, [prTool]).shown).toBe("Hi\n");
  });

  it("keeps normal text: angle brackets, the word null in a sentence, and other tags", () => {
    const text = "Use a < b and <b>bold</b>.\nThe value is null here.\nnullable\n<functional> stays";
    expect(run(text, 1).shown).toBe(text);
  });
});

const settings: NebiusSettings = { apiKey: "k", baseUrl: "https://nebius.test/v1", model: "m", maxOutputTokens: 256 };

function respond(texts: string[]) {
  return vi.fn<typeof fetch>(async () =>
    new Response(streamFrom([...texts.map((text) => sseEvent(deltaChunk(text))), sseEvent(finishChunk()), "data: [DONE]\n\n"]), { status: 200 }),
  );
}

const textOf = (chunks: CompletionChunk[]) => chunks.map((chunk) => (chunk.type === "text" ? chunk.text : "")).join("");

describe("Nebius adapter: tool calls written as text", () => {
  it("streams none of the leaked markup", async () => {
    const chunks = await collect(streamChatCompletion(settings, [{ role: "user", content: "x" }], { fetchImpl: respond(LEAKED.match(/.{1,4}/gs)!), tools: [prTool] }));
    expect(textOf(chunks)).toBe("I can check your pull requests.");
    expect(chunks.some((chunk) => chunk.type === "tool_calls")).toBe(false);
  });

  it("gives a whole text call as a tool call, which the normal zod check then validates", async () => {
    const chunks = await collect(streamChatCompletion(settings, [{ role: "user", content: "x" }], { fetchImpl: respond(QWEN_CALL.match(/.{1,5}/gs)!), tools: [prTool] }));
    expect(textOf(chunks)).toBe("");
    const calls = chunks.find((chunk) => chunk.type === "tool_calls");
    expect(calls).toEqual({ type: "tool_calls", calls: [{ id: "text_call_0", name: "github_list_pull_requests", arguments: '{"repo":"PATELOM925/P-Dot"}' }] });

    const offered = CONNECTOR_TOOLS.filter((tool) => tool.name === "github_list_pull_requests");
    const ok = checkToolCall(offered, (calls as { calls: { id: string; name: string; arguments: string }[] }).calls[0]!, new Map());
    expect(ok).toMatchObject({ ok: true, args: { repo: "PATELOM925/P-Dot" } });
    const bad = checkToolCall(offered, { id: "text_call_0", name: "github_list_pull_requests", arguments: '{"repo":"not a repo"}' }, new Map());
    expect(bad).toMatchObject({ ok: false });
  });
});
