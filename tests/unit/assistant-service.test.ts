import { describe, expect, it } from "vitest";
import { prepareChatTurn, streamChatTurn, type AssistantDeps } from "@/server/assistant/service";
import { ProviderError } from "@/server/providers/errors";
import type { ChatRequest, ChatStreamEvent } from "@/types/api";
import { FakeQuota, MemoryRepository, fakeDeps } from "../support/fakes";
import { collect } from "../support/streams";

const ALICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BOB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

async function runTurn(deps: AssistantDeps, request: ChatRequest, userId = ALICE, signal = new AbortController().signal) {
  const prepared = await prepareChatTurn(deps, { userId, requestId: "req-1", request });
  if (!prepared.ok) return { prepared, events: [] as ChatStreamEvent[] };
  const events = await collect(streamChatTurn(deps, prepared.turn, signal));
  return { prepared, events };
}

describe("prepareChatTurn", () => {
  it("creates a conversation titled from the first message and stores the user message", async () => {
    const repo = new MemoryRepository();
    const { deps } = fakeDeps({ repo });
    const prepared = await prepareChatTurn(deps, {
      userId: ALICE,
      requestId: "r",
      request: { action: "send", message: "Plan my week", webSearch: false },
    });

    expect(prepared.ok).toBe(true);
    expect(repo.conversations).toHaveLength(1);
    expect(repo.conversations[0]).toMatchObject({ title: "Plan my week", userId: ALICE });
    expect(repo.messages.map((m) => [m.role, m.content, m.userId])).toEqual([["user", "Plan my week", ALICE]]);
  });

  it("returns 404 for another user's conversation without consuming quota or writing", async () => {
    const repo = new MemoryRepository();
    const owned = await repo.createConversation(ALICE, "Alice's");
    const quota = new FakeQuota();
    const { deps } = fakeDeps({ repo, quota });

    const prepared = await prepareChatTurn(deps, {
      userId: BOB,
      requestId: "r",
      request: { action: "send", conversationId: owned.id, message: "let me in", webSearch: false },
    });

    expect(prepared).toMatchObject({ ok: false, status: 404, code: "not_found" });
    expect(quota.calls).toBe(0);
    expect(repo.messages).toHaveLength(0);
  });

  it("returns 429 with Retry-After when the quota is exhausted, before any write or provider call", async () => {
    const repo = new MemoryRepository();
    const { deps, prompts, searches } = fakeDeps({ repo, quota: new FakeQuota(false) });

    const { prepared } = await runTurn(deps, { action: "send", message: "hi", webSearch: true });

    expect(prepared).toMatchObject({ ok: false, status: 429, code: "rate_limited" });
    if (!prepared.ok) expect(prepared.headers?.["Retry-After"]).toBe("1800");
    expect(repo.conversations).toHaveLength(0);
    expect(prompts).toHaveLength(0);
    expect(searches).toHaveLength(0);
  });

  it("rejects a retry when the latest message already has a reply", async () => {
    const repo = new MemoryRepository();
    const { deps } = fakeDeps({ repo });
    const first = await runTurn(deps, { action: "send", message: "hi", webSearch: false });
    const conversationId = repo.conversations[0]!.id;
    expect(first.events.at(-1)?.type).toBe("done");

    const prepared = await prepareChatTurn(deps, {
      userId: ALICE,
      requestId: "r",
      request: { action: "retry", conversationId, webSearch: false },
    });
    expect(prepared).toMatchObject({ ok: false, status: 409, code: "conflict" });
  });
});

describe("streamChatTurn", () => {
  it("streams deltas and persists the completed reply", async () => {
    const repo = new MemoryRepository();
    const { deps, prompts } = fakeDeps({ repo, reply: ["Hello", " there."] });

    const { events } = await runTurn(deps, { action: "send", message: "hi", webSearch: false });

    expect(events.map((e) => e.type)).toEqual(["start", "delta", "delta", "done"]);
    const done = events.at(-1);
    expect(done).toMatchObject({ type: "done", message: { role: "assistant", content: "Hello there.", webSearch: "off" } });
    expect(repo.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(prompts[0]!.at(-1)).toEqual({ role: "user", content: "hi" });
  });

  it("does not call web search unless requested", async () => {
    const { deps, searches } = fakeDeps();
    const { events } = await runTurn(deps, { action: "send", message: "hi", webSearch: false });
    expect(searches).toHaveLength(0);
    expect(events.some((e) => e.type === "search")).toBe(false);
  });

  it("passes search results to the model and stores them as sources", async () => {
    const repo = new MemoryRepository();
    const { deps, searches, prompts } = fakeDeps({
      repo,
      search: async () => [{ title: "Doc", url: "https://example.com/doc", excerpt: "Fact." }],
    });

    const { events } = await runTurn(deps, { action: "send", message: "latest news?", webSearch: true });

    expect(searches).toEqual(["latest news?"]);
    expect(events.find((e) => e.type === "search")).toEqual({
      type: "search",
      status: "used",
      sources: [{ title: "Doc", url: "https://example.com/doc" }],
    });
    expect(prompts[0]!.at(-1)!.content).toContain("<web_search_results>");
    expect(repo.messages.at(-1)).toMatchObject({ webSearch: "used", sources: [{ title: "Doc", url: "https://example.com/doc" }] });
  });

  it("reports a search failure clearly and does not present the answer as web-grounded", async () => {
    const repo = new MemoryRepository();
    const { deps, prompts } = fakeDeps({
      repo,
      search: async () => {
        throw new ProviderError("tavily", "unavailable", 500);
      },
    });

    const { events } = await runTurn(deps, { action: "send", message: "q", webSearch: true });

    expect(events.find((e) => e.type === "search")).toMatchObject({ status: "failed", sources: [] });
    expect(prompts[0]![0]!.content).toContain("the search failed");
    expect(prompts[0]!.at(-1)!.content).toBe("q");
    expect(repo.messages.at(-1)).toMatchObject({ role: "assistant", webSearch: "failed", sources: [] });
  });

  it("reports failure when search is requested but not configured", async () => {
    const { deps } = fakeDeps({ search: null });
    const { events } = await runTurn(deps, { action: "send", message: "q", webSearch: true });
    expect(events.find((e) => e.type === "search")).toMatchObject({ status: "failed" });
    expect(events.at(-1)?.type).toBe("done");
  });

  it("turns a provider failure into an error event and saves no assistant message", async () => {
    const repo = new MemoryRepository();
    const { deps, logs } = fakeDeps({
      repo,
      reply: async function* () {
        yield { type: "text" as const, text: "partial-reply-text" };
        throw new ProviderError("nebius", "rate_limited", 429);
      },
    });

    const { events } = await runTurn(deps, { action: "send", message: "my private question", webSearch: false });

    expect(events.at(-1)).toMatchObject({ type: "error", code: "provider_rate_limited", retryable: true });
    expect(repo.messages.map((m) => m.role)).toEqual(["user"]);
    // Logs carry metadata only.
    expect(logs.map((l) => l.event)).toContain("completion_failed");
    expect(JSON.stringify(logs)).not.toContain("private question");
    expect(JSON.stringify(logs)).not.toContain("partial-reply-text");
  });

  it("can retry the unanswered message without duplicating it", async () => {
    const repo = new MemoryRepository();
    let fail = true;
    const { deps, prompts } = fakeDeps({
      repo,
      reply: async function* () {
        if (fail) throw new ProviderError("nebius", "timeout");
        yield { type: "text" as const, text: "Recovered." };
        yield { type: "finish" as const, finishReason: "stop", usage: null };
      },
    });

    await runTurn(deps, { action: "send", message: "hello?", webSearch: false });
    fail = false;
    const conversationId = repo.conversations[0]!.id;
    const { events } = await runTurn(deps, { action: "retry", conversationId, webSearch: false });

    expect(events[0]).toMatchObject({ type: "start", userMessage: { content: "hello?" } });
    expect(events.at(-1)).toMatchObject({ type: "done", message: { content: "Recovered." } });
    expect(repo.messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "hello?"],
      ["assistant", "Recovered."],
    ]);
    expect(prompts[1]!.filter((m) => m.role === "user")).toHaveLength(1);
  });

  it("stops without saving when the client disconnects", async () => {
    const repo = new MemoryRepository();
    const controller = new AbortController();
    const { deps } = fakeDeps({
      repo,
      reply: async function* () {
        yield { type: "text" as const, text: "partial" };
        controller.abort();
        throw new ProviderError("nebius", "aborted");
      },
    });

    const { events } = await runTurn(deps, { action: "send", message: "hi", webSearch: false }, ALICE, controller.signal);

    expect(events.map((e) => e.type)).toEqual(["start", "delta"]);
    expect(repo.messages.map((m) => m.role)).toEqual(["user"]);
  });

  it("reports an empty reply as a failure", async () => {
    const { deps } = fakeDeps({ reply: [] });
    const { events } = await runTurn(deps, { action: "send", message: "hi", webSearch: false });
    expect(events.at(-1)).toMatchObject({ type: "error", code: "provider_unavailable" });
  });

  it("reports when the reply cannot be saved", async () => {
    const repo = new MemoryRepository();
    repo.failInsertForRole = "assistant";
    const { deps } = fakeDeps({ repo });
    const { events } = await runTurn(deps, { action: "send", message: "hi", webSearch: false });
    expect(events.at(-1)).toMatchObject({ type: "error", code: "internal_error" });
  });

  it("flags replies cut off by the output token limit", async () => {
    const { deps } = fakeDeps({
      reply: async function* () {
        yield { type: "text" as const, text: "long" };
        yield { type: "finish" as const, finishReason: "length", usage: null };
      },
    });
    const { events } = await runTurn(deps, { action: "send", message: "hi", webSearch: false });
    expect(events.at(-1)).toMatchObject({ type: "done", truncated: true });
  });
});
