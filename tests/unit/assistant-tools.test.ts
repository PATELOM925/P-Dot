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

  it("proposes a reminder via propose_reminder tool and emits action event", async () => {
    const repo = new MemoryRepository();
    let pass = 0;

    const { deps } = fakeDeps({
      repo,
      reply: async function* (messages, _signal, options) {
        pass += 1;
        if (pass === 1) {
          // Model chooses to propose a reminder
          expect(options?.tools?.some((t) => t.function.name === "propose_reminder")).toBe(true);
          yield {
            type: "tool_calls" as const,
            calls: [
              {
                id: "call_remind_99",
                type: "function" as const,
                function: {
                  name: "propose_reminder",
                  arguments: JSON.stringify({
                    title: "Call Dentist",
                    due_at: "tomorrow at 9am",
                    notes: "Check teeth cleaning appointment",
                  }),
                },
              },
            ],
          };
          yield { type: "finish" as const, finishReason: "tool_calls", usage: null };
        } else {
          // Confirmation pass
          expect(messages.some((m) => m.role === "tool" && m.tool_call_id === "call_remind_99")).toBe(true);
          yield { type: "text" as const, text: "I have prepared a reminder for you to call the dentist tomorrow at 9:00 AM." };
          yield { type: "finish" as const, finishReason: "stop", usage: null };
        }
      },
    });

    const { events } = await runTurn(deps, {
      action: "send",
      message: "Remind me to call the dentist tomorrow at 9am",
      webSearch: false,
    });

    // Check action event
    const actionEvent = events.find((e) => e.type === "action");
    expect(actionEvent).toBeDefined();
    expect(actionEvent).toMatchObject({
      type: "action",
      action: {
        kind: "reminder",
        title: "Call Dentist",
        dueAt: "tomorrow at 9am",
        notes: "Check teeth cleaning appointment",
      },
    });

    // Check message persistence includes action
    const doneEvent = events.find((e) => e.type === "done");
    expect(doneEvent).toBeDefined();
    if (doneEvent && doneEvent.type === "done") {
      expect(doneEvent.message.actions).toHaveLength(1);
      expect(doneEvent.message.actions?.[0]?.title).toBe("Call Dentist");
    }
  });

  it("proposes a task via propose_task tool and emits action event", async () => {
    const repo = new MemoryRepository();
    let pass = 0;

    const { deps } = fakeDeps({
      repo,
      reply: async function* () {
        pass += 1;
        if (pass === 1) {
          yield {
            type: "tool_calls" as const,
            calls: [
              {
                id: "call_task_42",
                type: "function" as const,
                function: {
                  name: "propose_task",
                  arguments: JSON.stringify({
                    title: "Review PR #42",
                    priority: "high",
                    due_date: "2026-10-25",
                  }),
                },
              },
            ],
          };
          yield { type: "finish" as const, finishReason: "tool_calls", usage: null };
        } else {
          yield { type: "text" as const, text: "I have added a high-priority task for you to review PR #42." };
          yield { type: "finish" as const, finishReason: "stop", usage: null };
        }
      },
    });

    const { events } = await runTurn(deps, {
      action: "send",
      message: "Add review PR #42 to my high priority tasks",
      webSearch: false,
    });

    const actionEvent = events.find((e) => e.type === "action");
    expect(actionEvent).toMatchObject({
      type: "action",
      action: {
        kind: "task",
        title: "Review PR #42",
        priority: "high",
        dueDate: "2026-10-25",
      },
    });
  });

  it("executes multi-hop search when first search requires follow-up, respecting 3-attempt limit and emitting thought events", async () => {
    const repo = new MemoryRepository();
    let pass = 0;

    const { deps, searches } = fakeDeps({
      repo,
      search: async (query) => {
        if (query.includes("iPhone")) {
          return [{ title: "iPhone 16 Specs", url: "https://apple.test", excerpt: "iPhone 16 battery is 3582 mAh." }];
        }
        return [{ title: "Galaxy S24 Specs", url: "https://samsung.test", excerpt: "Galaxy S24 battery is 4000 mAh." }];
      },
      reply: async function* (messages, _signal, options) {
        pass += 1;
        if (pass === 1) {
          // Hop 0: Model searches for iPhone
          yield {
            type: "tool_calls" as const,
            calls: [
              {
                id: "call_hop_1",
                type: "function" as const,
                function: {
                  name: "web_search",
                  arguments: JSON.stringify({ query: "iPhone 16 battery" }),
                },
              },
            ],
          };
          yield { type: "finish" as const, finishReason: "tool_calls", usage: null };
        } else if (pass === 2) {
          // Hop 1: Tools are still available; model searches for Galaxy S24
          expect(options?.tools).toBeDefined();
          yield {
            type: "tool_calls" as const,
            calls: [
              {
                id: "call_hop_2",
                type: "function" as const,
                function: {
                  name: "web_search",
                  arguments: JSON.stringify({ query: "Galaxy S24 battery" }),
                },
              },
            ],
          };
          yield { type: "finish" as const, finishReason: "tool_calls", usage: null };
        } else if (pass === 3) {
          // Hop 2: Final attempt reached, tools are disabled
          expect(options?.tools).toBeUndefined();
          yield { type: "text" as const, text: "iPhone 16 has 3582 mAh [1] while Galaxy S24 has 4000 mAh [2]." };
          yield { type: "finish" as const, finishReason: "stop", usage: null };
        }
      },
    });

    const { events } = await runTurn(deps, {
      action: "send",
      message: "Compare iPhone 16 and Galaxy S24 battery",
      webSearch: false,
    });

    expect(searches).toEqual(["iPhone 16 battery", "Galaxy S24 battery"]);

    // Verify thought events were emitted for both hops
    const thoughtEvents = events.filter((e) => e.type === "thought");
    expect(thoughtEvents.length).toBeGreaterThanOrEqual(2);

    const doneEvent = events.find((e) => e.type === "done");
    expect(doneEvent).toBeDefined();
    if (doneEvent && doneEvent.type === "done") {
      expect(doneEvent.message.content).toContain("3582 mAh");
      expect(doneEvent.message.content).toContain("4000 mAh");
    }
  });

  it("executes autonomous search_documents tool and cites personal document excerpts", async () => {
    const repo = new MemoryRepository();
    const { createMockDocumentRepository } = await import("@/server/db/documents");
    const docRepo = createMockDocumentRepository(
      [
        {
          id: "doc_office",
          userId: USER_ID,
          filename: "office-handbook.pdf",
          filePath: null,
          fileSize: 1200,
          mimeType: "application/pdf",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
      [
        {
          id: "chunk_wifi",
          userId: USER_ID,
          documentId: "doc_office",
          filename: "office-handbook.pdf",
          chunkIndex: 0,
          content: "The guest Wi-Fi network is 'PDot-Guest' with password 'supersecret2026'.",
          embedding: [1, 0, 0, 0],
        },
      ],
    );

    let pass = 0;
    const { deps } = fakeDeps({
      repo,
      documentRepo: docRepo,
      embed: async () => [0.99, 0.01, 0, 0],
      reply: async function* (messages, _signal, options) {
        pass += 1;
        if (pass === 1) {
          // Verify search_documents tool is offered
          expect(options?.tools?.some((t) => t.function.name === "search_documents")).toBe(true);
          yield {
            type: "tool_calls" as const,
            calls: [
              {
                id: "call_rag_01",
                type: "function" as const,
                function: {
                  name: "search_documents",
                  arguments: JSON.stringify({ query: "office wifi password" }),
                },
              },
            ],
          };
          yield { type: "finish" as const, finishReason: "tool_calls", usage: null };
        } else {
          // Tool feedback pass
          const toolMsg = messages.find((m) => m.role === "tool" && m.tool_call_id === "call_rag_01");
          expect(toolMsg).toBeDefined();
          expect(toolMsg?.content).toContain("office-handbook.pdf");
          expect(toolMsg?.content).toContain("supersecret2026");

          yield {
            type: "text" as const,
            text: "According to your office handbook, the guest Wi-Fi password is 'supersecret2026' [1].",
          };
          yield { type: "finish" as const, finishReason: "stop", usage: null };
        }
      },
    });

    const { events } = await runTurn(deps, {
      action: "send",
      message: "What is the office wifi password?",
      webSearch: false,
    });

    // Check thought event
    const thoughtEvent = events.find((e) => e.type === "thought");
    expect(thoughtEvent).toBeDefined();
    expect(thoughtEvent).toMatchObject({
      type: "thought",
      text: expect.stringContaining("Searching personal documents"),
    });

    // Check search event with document source
    const searchEvent = events.find((e) => e.type === "search");
    expect(searchEvent).toBeDefined();
    expect(searchEvent).toMatchObject({
      type: "search",
      status: "used",
      sources: [
        {
          title: "office-handbook.pdf (Section 1)",
          url: "doc://doc_office#chunk-0",
        },
      ],
    });

    // Check done event and saved message
    const doneEvent = events.find((e) => e.type === "done");
    expect(doneEvent).toBeDefined();
    if (doneEvent && doneEvent.type === "done") {
      expect(doneEvent.message.content).toContain("supersecret2026");
      expect(doneEvent.message.sources).toHaveLength(1);
      expect(doneEvent.message.sources[0]?.title).toBe("office-handbook.pdf (Section 1)");
    }

    expect(repo.messages[1]?.sources[0]?.title).toBe("office-handbook.pdf (Section 1)");
  });
});

