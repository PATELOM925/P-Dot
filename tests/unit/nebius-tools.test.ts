import { describe, expect, it, vi } from "vitest";
import { ProviderError } from "@/server/providers/errors";
import { streamChatCompletion, type ChatMessage, type NebiusSettings, type ToolDefinition } from "@/server/providers/nebius/client";
import { inputTokenBound } from "@/server/providers/nebius/pricing";
import { collect, deltaChunk, sseEvent, streamFrom } from "../support/streams";

// Raw tool-call wire data through the real adapter (lesson 7 in
// docs/PROVIDER-RELIABILITY.md). The shapes follow the OpenAI-compatible
// streaming format that vLLM servers send: the first delta of a call has its
// index, ID, type and name, and the arguments arrive in later deltas.

const settings: NebiusSettings = {
  apiKey: "test-key",
  baseUrl: "https://nebius.test/v1",
  model: "test/model",
  maxOutputTokens: 256,
};

const searchTool: ToolDefinition = {
  name: "web_search",
  description: "Search the web.",
  parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
};

const toolDelta = (call: Record<string, unknown>) => ({
  object: "chat.completion.chunk",
  choices: [{ index: 0, delta: { tool_calls: [call] }, finish_reason: null }],
});

const finishWith = (reason: string) => ({ object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: reason }] });
const usageOnly = { object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 300, completion_tokens: 21 } };

function respond(events: unknown[]) {
  const fetchImpl = vi.fn<typeof fetch>(
    async () => new Response(streamFrom(events.map((event) => sseEvent(event))), { status: 200 }),
  );
  return fetchImpl;
}

const sentBody = (fetchImpl: ReturnType<typeof respond>) => JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body)) as Record<string, unknown>;

describe("Nebius adapter: tool calls", () => {
  it("joins one streamed call and sends tools with tool_choice auto", async () => {
    const fetchImpl = respond([
      {
        object: "chat.completion.chunk",
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              content: null,
              tool_calls: [{ index: 0, id: "chatcmpl-tool-99372708ace9fdd5", type: "function", function: { name: "web_search", arguments: "" } }],
            },
            finish_reason: null,
          },
        ],
      },
      toolDelta({ index: 0, function: { arguments: '{"query": ' } }),
      toolDelta({ index: 0, function: { arguments: '"Tokyo weather"}' } }),
      finishWith("tool_calls"),
      usageOnly,
      "[DONE]",
    ]);

    const chunks = await collect(
      streamChatCompletion(settings, [{ role: "user", content: "Weather in Tokyo?" }], { fetchImpl, tools: [searchTool] }),
    );

    expect(chunks).toEqual([
      { type: "tool_progress" },
      { type: "tool_calls", calls: [{ id: "chatcmpl-tool-99372708ace9fdd5", name: "web_search", arguments: '{"query": "Tokyo weather"}' }] },
      { type: "finish", finishReason: "tool_calls", usage: { promptTokens: 300, completionTokens: 21 } },
    ]);
    expect(sentBody(fetchImpl)).toMatchObject({
      tools: [{ type: "function", function: { name: "web_search", description: "Search the web.", parameters: searchTool.parameters } }],
      tool_choice: "auto",
    });
  });

  it("joins two calls whose deltas arrive interleaved, in index order", async () => {
    const fetchImpl = respond([
      toolDelta({ index: 1, id: "b", function: { name: "web_search", arguments: '{"query":' } }),
      toolDelta({ index: 0, id: "a", function: { name: "web_", arguments: "" } }),
      toolDelta({ index: 0, function: { name: "search", arguments: '{"query":"one"}' } }),
      toolDelta({ index: 1, function: { arguments: '"two"}' } }),
      finishWith("tool_calls"),
      "[DONE]",
    ]);

    const chunks = await collect(streamChatCompletion(settings, [{ role: "user", content: "x" }], { fetchImpl, tools: [searchTool] }));

    expect(chunks.filter((chunk) => chunk.type === "tool_progress")).toHaveLength(2);
    expect(chunks.find((chunk) => chunk.type === "tool_calls")).toEqual({
      type: "tool_calls",
      calls: [
        { id: "a", name: "web_search", arguments: '{"query":"one"}' },
        { id: "b", name: "web_search", arguments: '{"query":"two"}' },
      ],
    });
  });

  it("keeps text that comes before a call, and gives an ID to a call that has none", async () => {
    const fetchImpl = respond([
      deltaChunk("Let me check."),
      toolDelta({ function: { name: "web_search", arguments: '{"query":"x"}' } }),
      finishWith("tool_calls"),
      "[DONE]",
    ]);

    const chunks = await collect(streamChatCompletion(settings, [{ role: "user", content: "x" }], { fetchImpl, tools: [searchTool] }));

    expect(chunks.slice(0, 3)).toEqual([
      { type: "text", text: "Let me check." },
      { type: "tool_progress" },
      { type: "tool_calls", calls: [{ id: "call_0", name: "web_search", arguments: '{"query":"x"}' }] },
    ]);
  });

  it("drops a call that never got a name", async () => {
    const fetchImpl = respond([toolDelta({ index: 0, id: "a", function: { arguments: "{}" } }), deltaChunk("Fine."), finishWith("stop"), "[DONE]"]);

    const chunks = await collect(streamChatCompletion(settings, [{ role: "user", content: "x" }], { fetchImpl, tools: [searchTool] }));

    expect(chunks.some((chunk) => chunk.type === "tool_calls")).toBe(false);
    expect(chunks).toContainEqual({ type: "text", text: "Fine." });
  });

  it("refuses arguments that grow past the limit as a malformed response", async () => {
    const fetchImpl = respond([
      toolDelta({ index: 0, id: "a", function: { name: "web_search", arguments: "x".repeat(16_001) } }),
      finishWith("tool_calls"),
      "[DONE]",
    ]);

    const error = await collect(
      streamChatCompletion(settings, [{ role: "user", content: "x" }], { fetchImpl, tools: [searchTool] }),
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).kind).toBe("bad_response");
  });

  it("refuses a tool call index above the limit as a malformed response", async () => {
    const fetchImpl = respond([toolDelta({ index: 8, id: "a", function: { name: "web_search", arguments: "{}" } }), "[DONE]"]);

    const error = await collect(
      streamChatCompletion(settings, [{ role: "user", content: "x" }], { fetchImpl, tools: [searchTool] }),
    ).catch((e: unknown) => e);

    expect((error as ProviderError).kind).toBe("bad_response");
  });

  it("sends no tools field when no tool is offered", async () => {
    const fetchImpl = respond([deltaChunk("Hi"), finishWith("stop"), "[DONE]"]);
    await collect(streamChatCompletion(settings, [{ role: "user", content: "x" }], { fetchImpl }));

    const body = sentBody(fetchImpl);
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("tool_choice");
  });

  it("sends earlier tool calls and tool results in the OpenAI wire format", async () => {
    const fetchImpl = respond([deltaChunk("Done."), finishWith("stop"), "[DONE]"]);
    const messages: ChatMessage[] = [
      { role: "user", content: "Weather?" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "web_search", arguments: '{"query":"w"}' }] },
      { role: "tool", toolCallId: "c1", content: "<web_search_results>…</web_search_results>" },
    ];

    await collect(streamChatCompletion(settings, messages, { fetchImpl }));

    expect(sentBody(fetchImpl).messages).toEqual([
      { role: "user", content: "Weather?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "c1", type: "function", function: { name: "web_search", arguments: '{"query":"w"}' } }],
      },
      { role: "tool", tool_call_id: "c1", content: "<web_search_results>…</web_search_results>" },
    ]);
  });
});

describe("inputTokenBound with tools", () => {
  const base: ChatMessage[] = [{ role: "user", content: "hi" }];

  it("counts every byte of the tool definitions as sent", () => {
    const without = inputTokenBound(base);
    const withTools = inputTokenBound(base, 0, [searchTool]);
    const sent = new TextEncoder().encode(
      JSON.stringify({ tools: [{ type: "function", function: searchTool }], tool_choice: "auto" }),
    ).length;
    expect(withTools - without).toBeGreaterThanOrEqual(sent);
  });

  it("counts tool call arguments and tool result IDs", () => {
    const call = { id: "c1", name: "web_search", arguments: "é".repeat(500) };
    const messages: ChatMessage[] = [...base, { role: "assistant", content: "", toolCalls: [call] }, { role: "tool", toolCallId: "c1", content: "r" }];
    expect(inputTokenBound(messages) - inputTokenBound(base)).toBeGreaterThan(1_000 + "c1".length * 2 + "web_search".length);
  });
});
