import { describe, expect, it } from "vitest";
import { prepareChatTurn, streamChatTurn, type AssistantDeps } from "@/server/assistant/service";
import { cleanTitle, TITLE_MAX_OUTPUT_TOKENS } from "@/server/assistant/title";
import type { CompletionChunk, ModelCallRequest, ModelProvider } from "@/server/providers/model";
import type { ChatRequest, ChatStreamEvent } from "@/types/api";
import { FakeSpend, MemoryRepository, fakeDeps } from "../support/fakes";
import { collect } from "../support/streams";

const ALICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

/** Replies with `reply`, and with `title` to a title call (the call with 32 output tokens). */
function provider(reply: string, title: string | Error) {
  const requests: ModelCallRequest[] = [];
  const model: ModelProvider = {
    name: "nebius",
    stream(request) {
      requests.push(request);
      const isTitle = request.maxOutputTokens === TITLE_MAX_OUTPUT_TOKENS;
      return (async function* (): AsyncGenerator<CompletionChunk> {
        if (isTitle && title instanceof Error) throw title;
        yield { type: "text", text: isTitle ? (title as string) : reply };
        yield { type: "finish", finishReason: "stop", usage: { promptTokens: 20, completionTokens: 4 } };
      })();
    },
  };
  return { model, requests };
}

async function run(deps: AssistantDeps, request: ChatRequest, waited: Promise<unknown>[]) {
  const prepared = await prepareChatTurn(deps, { userId: ALICE, requestId: "r", request });
  if (!prepared.ok) throw new Error(prepared.code);
  const events = await collect(streamChatTurn(deps, prepared.turn, new AbortController().signal));
  await Promise.all(waited);
  return { events, turn: prepared.turn };
}

const types = (events: ChatStreamEvent[]) => events.map((e) => e.type);

describe("chat titles made by the model", () => {
  it("renames a new conversation after done, on the fast tier, with a settled hold", async () => {
    const repo = new MemoryRepository();
    const spend = new FakeSpend();
    const { model, requests } = provider("Here is a plan.", '"Weekend Trip Plan."');
    const { deps, waited } = fakeDeps({ repo, spend, provider: model });
    deps.titles = true;

    const { events, turn } = await run(deps, { action: "send", message: "Help me plan a weekend trip to Goa", webSearch: false }, waited);

    expect(types(events).slice(-2)).toEqual(["done", "title"]);
    expect(events.at(-1)).toEqual({ type: "title", conversationId: turn.conversation.id, title: "Weekend Trip Plan" });
    expect(repo.conversations[0]!.title).toBe("Weekend Trip Plan");
    const titleCall = requests.at(-1)!;
    expect(titleCall.maxOutputTokens).toBe(TITLE_MAX_OUTPUT_TOKENS);
    expect(titleCall.thinkingBudgetTokens).toBe(0);
    expect(titleCall.messages[0]!.content).not.toContain("Goa");
    expect(titleCall.messages[1]!.content).toContain("<user_message>");
    const nebius = spend.reservations.filter((r) => r.provider === "nebius");
    expect(nebius).toHaveLength(2);
    expect(nebius.every((r) => r.settled !== null)).toBe(true);
  });

  it("makes no title for a later message", async () => {
    const repo = new MemoryRepository();
    const { model, requests } = provider("OK.", "Title");
    const { deps, waited } = fakeDeps({ repo, provider: model });
    const first = await run(deps, { action: "send", message: "First", webSearch: false }, waited);
    deps.titles = true;

    const { events } = await run(deps, { action: "send", conversationId: first.turn.conversation.id, message: "Second", webSearch: false }, waited);

    expect(types(events)).not.toContain("title");
    expect(requests.filter((r) => r.maxOutputTokens === TITLE_MAX_OUTPUT_TOKENS)).toHaveLength(0);
  });

  it("keeps the first-message title and sends no error when the title call fails or the budget refuses it", async () => {
    const repo = new MemoryRepository();
    const { model } = provider("OK.", new Error("down"));
    const { deps, waited, logs } = fakeDeps({ repo, provider: model });
    deps.titles = true;

    const { events } = await run(deps, { action: "send", message: "Plan dinner", webSearch: false }, waited);

    expect(types(events).at(-1)).toBe("done");
    expect(repo.conversations[0]!.title).toBe("Plan dinner");
    expect(logs.some((l) => l.event === "title_failed")).toBe(true);

    const spend = new FakeSpend();
    const refused = fakeDeps({ provider: provider("OK.", "T").model, spend });
    refused.deps.titles = true;
    const reserve = spend.reserve.bind(spend);
    spend.reserve = async (p, amount) =>
      spend.reservations.some((r) => r.provider === "nebius") && p === "nebius" ? { allowed: false, limit: "user" } : reserve(p, amount);
    const second = await run(refused.deps, { action: "send", message: "Plan lunch", webSearch: false }, refused.waited);
    expect(types(second.events).at(-1)).toBe("done");
  });

  it("cleans the model's title", () => {
    expect(cleanTitle("Title: **Tokyo Trip**")).toBe("Tokyo Trip");
    expect(cleanTitle("“Budget Review.”\nMore text")).toBe("Budget Review");
    expect(cleanTitle("  ")).toBeNull();
    expect(cleanTitle("x".repeat(100))!.length).toBe(60);
  });
});
