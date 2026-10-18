import { describe, expect, it } from "vitest";
import { prepareChatTurn, streamChatTurn } from "@/server/assistant/service";
import type { ChatRequest } from "@/types/api";
import { MemoryRepository, fakeDeps } from "../support/fakes";
import { collect } from "../support/streams";

const USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

async function runTurn(deps: ReturnType<typeof fakeDeps>["deps"], request: ChatRequest) {
  const prepared = await prepareChatTurn(deps, { userId: USER_ID, requestId: "req-tools", request });
  if (!prepared.ok) throw new Error(`Prepare failed: ${prepared.message}`);
  const events = await collect(streamChatTurn(deps, prepared.turn, new AbortController().signal));
  return { prepared, events };
}

describe("Autonomous Tool Calling (AI-04)", () => {
  it("executes autonomous web_search tool when model requests it even if toggle was off", async () => {
    const repo = new MemoryRepository();
    let pass = 0;

    const { deps, searches } = fakeDeps({
      repo,
      search: async (query) => [
        { title: "Tokyo Weather", url: "https://weather.test/tokyo", excerpt: `Current weather for ${query}: Sunny, 22C.` },
      ],
      reply: async function* (messages, _signal, options) {
        pass += 1;
        if (pass === 1) {
          // Verify WEB_SEARCH_TOOL was provided to the model in options
          expect(options?.tools?.[0]?.function.name).toBe("web_search");
          expect(options?.toolChoice).toBe("auto");

          // Model emits a tool call for web_search
          yield {
            type: "tool_calls" as const,
            calls: [
              {
                id: "call_tokyo_123",
                type: "function" as const,
                function: {
                  name: "web_search",
                  arguments: JSON.stringify({ query: "Tokyo weather today" }),
                },
              },
            ],
          };
          yield { type: "finish" as const, finishReason: "tool_calls", usage: { promptTokens: 50, completionTokens: 20 } };
        } else {
          // Second pass: model received the tool result message
          const toolMsg = messages.find((m) => m.role === "tool");
          expect(toolMsg).toBeDefined();
          expect(toolMsg?.tool_call_id).toBe("call_tokyo_123");
          expect(toolMsg?.content).toContain("Tokyo Weather");

          yield { type: "text" as const, text: "It is currently sunny and 22°C in Tokyo." };
          yield { type: "finish" as const, finishReason: "stop", usage: { promptTokens: 120, completionTokens: 15 } };
        }
      },
    });

    // Request with webSearch: false (autonomous mode)
    const { events } = await runTurn(deps, {
      action: "send",
      message: "What is the weather in Tokyo?",
      webSearch: false,
    });

    // Verify search was invoked with the model's chosen query
    expect(searches).toEqual(["Tokyo weather today"]);

    // Verify search event was emitted to client
    const searchEvent = events.find((e) => e.type === "search");
    expect(searchEvent).toMatchObject({
      type: "search",
      status: "used",
      sources: [{ title: "Tokyo Weather", url: "https://weather.test/tokyo" }],
    });

    // Verify done event and message persistence
    const doneEvent = events.find((e) => e.type === "done");
    expect(doneEvent).toMatchObject({
      type: "done",
      message: {
        role: "assistant",
        content: "It is currently sunny and 22°C in Tokyo.",
        webSearch: "used",
        sources: [{ title: "Tokyo Weather", url: "https://weather.test/tokyo" }],
      },
    });

    expect(repo.messages).toHaveLength(2);
    expect(repo.messages[1]).toMatchObject({
      role: "assistant",
      webSearch: "used",
      sources: [{ title: "Tokyo Weather", url: "https://weather.test/tokyo" }],
    });
  });

  it("handles malformed JSON in tool call arguments by falling back to user message", async () => {
    const repo = new MemoryRepository();
    let pass = 0;

    const { deps, searches } = fakeDeps({
      repo,
      search: async () => [{ title: "Result", url: "https://example.com", excerpt: "Data." }],
      reply: async function* () {
        pass += 1;
        if (pass === 1) {
          yield {
            type: "tool_calls" as const,
            calls: [
              {
                id: "call_broken_json",
                type: "function" as const,
                function: {
                  name: "web_search",
                  arguments: "{ broken json...",
                },
              },
            ],
          };
          yield { type: "finish" as const, finishReason: "tool_calls", usage: null };
        } else {
          yield { type: "text" as const, text: "Grounded answer." };
          yield { type: "finish" as const, finishReason: "stop", usage: null };
        }
      },
    });

    const { events } = await runTurn(deps, {
      action: "send",
      message: "original question",
      webSearch: false,
    });

    // Fallback to original user message
    expect(searches).toEqual(["original question"]);
    expect(events.find((e) => e.type === "done")).toBeDefined();
  });
});
