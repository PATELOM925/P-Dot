import { describe, expect, it } from "vitest";
import { MAX_ASSISTANT_CHARS } from "@/lib/limits";
import { prepareChatTurn, streamChatTurn, type AssistantDeps } from "@/server/assistant/service";
import {
  budgetRefusal,
  MAX_NEBIUS_HOLD_MICRO_USD,
  nebiusHoldMicroUsd,
  nebiusSettleMicroUsd,
  SEARCH_BUDGET_MESSAGE,
} from "@/server/assistant/spend";
import { toNdjsonStream } from "@/server/http/ndjson";
import { ProviderError } from "@/server/providers/errors";
import { costMicroUsd, priceForModel } from "@/server/providers/nebius/pricing";
import type { ChatRequest, ChatStreamEvent } from "@/types/api";
import { FakeQuota, FakeSpend, MemoryRepository, fakeDeps } from "../support/fakes";
import { collect } from "../support/streams";

const ALICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SUPER = "nvidia/nemotron-3-super-120b-a12b";

async function runTurn(deps: AssistantDeps, request: ChatRequest, signal = new AbortController().signal) {
  const prepared = await prepareChatTurn(deps, { userId: ALICE, requestId: "req-1", request });
  if (!prepared.ok) return { prepared, events: [] as ChatStreamEvent[] };
  const events = await collect(streamChatTurn(deps, prepared.turn, signal));
  return { prepared, events };
}

const send = (webSearch = false): ChatRequest => ({ action: "send", message: "hi", webSearch });

describe("spend math", () => {
  it("holds the worst case: every input byte as a token plus the full output limit", () => {
    const messages = [{ role: "user" as const, content: "x".repeat(1000) }];
    // (1000 bytes + 16 + 64) * 300 nano + 1024 * 900 nano = 324,000 + 921,600 nano = 1,245.6 micro.
    expect(nebiusHoldMicroUsd(SUPER, messages, 1024)).toBe(1246);
    // An unknown model uses the most expensive price.
    expect(nebiusHoldMicroUsd("new/model", messages, 1024)).toBe(Math.ceil((1080 * 1000 + 1024 * 3000) / 1000));
  });

  it("never holds more than the database accepts", () => {
    const huge = [{ role: "user" as const, content: "x".repeat(400_000) }];
    expect(nebiusHoldMicroUsd("new/model", huge, 8192)).toBe(MAX_NEBIUS_HOLD_MICRO_USD);
  });

  it("settles the real cost with usage, and the full hold without it", () => {
    expect(nebiusSettleMicroUsd(SUPER, 5000, { promptTokens: 37, completionTokens: 45 })).toBe(52);
    expect(nebiusSettleMicroUsd(SUPER, 5000, null)).toBe(5000);
    // Never more than the hold.
    expect(nebiusSettleMicroUsd(SUPER, 10, { promptTokens: 1_000_000, completionTokens: 0 })).toBe(10);
  });

  it("maps each cap to a clear public error", () => {
    const now = new Date(Date.UTC(2026, 9, 14, 12, 30, 0));
    expect(budgetRefusal("day", now)).toEqual({
      status: 429,
      code: "budget_exhausted",
      message: "P-Dot has reached its daily usage limit. Try again tomorrow.",
      headers: { "Retry-After": String(11.5 * 3600) },
    });
    expect(budgetRefusal("user", now)).toMatchObject({
      status: 429,
      message: "You have reached your daily usage limit. Try again tomorrow.",
    });
    expect(budgetRefusal("period", now)).toEqual({
      status: 503,
      code: "budget_exhausted",
      message: "P-Dot has reached its total usage limit. Try again later.",
    });
  });
});

describe("chat flow with the spend guard", () => {
  it("holds before the call and settles the real cost after a reply", async () => {
    const spend = new FakeSpend();
    const { deps, prompts, waited } = fakeDeps({ spend });

    const { events } = await runTurn(deps, send());

    expect(events.at(-1)?.type).toBe("done");
    expect(spend.reservations).toHaveLength(1);
    const [nebius] = spend.reservations;
    // The hold covers the prompt that was really sent.
    expect(nebius!.held).toBeGreaterThanOrEqual(nebiusHoldMicroUsd(SUPER, prompts[0]!, 1024));
    // The fake reply reports 10 prompt and 2 completion tokens.
    const cost = costMicroUsd(priceForModel(SUPER).price, { promptTokens: 10, completionTokens: 2 });
    expect(nebius!.settled).toBe(cost);
    expect(waited).toHaveLength(1);
  });

  it("settles the full hold when the provider fails", async () => {
    const spend = new FakeSpend();
    const { deps } = fakeDeps({
      spend,
      reply: async function* () {
        yield { type: "text" as const, text: "part" };
        throw new ProviderError("nebius", "unavailable", 500);
      },
    });
    const { events } = await runTurn(deps, send());
    expect(events.at(-1)).toMatchObject({ type: "error" });
    expect(spend.reservations[0]!.settled).toBe(spend.reservations[0]!.held);
  });

  it("settles the full hold when usage does not arrive", async () => {
    const spend = new FakeSpend();
    const { deps } = fakeDeps({
      spend,
      reply: async function* () {
        yield { type: "text" as const, text: "ok" };
        yield { type: "finish" as const, finishReason: "stop", usage: null };
      },
    });
    await runTurn(deps, send());
    expect(spend.reservations[0]!.settled).toBe(spend.reservations[0]!.held);
  });

  it("settles the full hold when the reply is cut at the character limit", async () => {
    const spend = new FakeSpend();
    const { deps } = fakeDeps({
      spend,
      reply: async function* () {
        yield { type: "text" as const, text: "x".repeat(MAX_ASSISTANT_CHARS + 10) };
        yield { type: "finish" as const, finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1 } };
      },
    });
    const { events } = await runTurn(deps, send());
    expect(events.at(-1)).toMatchObject({ type: "done", truncated: true });
    expect(spend.reservations[0]!.settled).toBe(spend.reservations[0]!.held);
  });

  it("settles when the client disconnects (abort signal)", async () => {
    const spend = new FakeSpend();
    const controller = new AbortController();
    const { deps } = fakeDeps({
      spend,
      reply: async function* () {
        yield { type: "text" as const, text: "partial" };
        controller.abort();
        throw new ProviderError("nebius", "aborted");
      },
    });
    await runTurn(deps, send(), controller.signal);
    expect(spend.reservations[0]!.settled).toBe(spend.reservations[0]!.held);
  });

  it("settles when the user presses Stop and the response stream is cancelled", async () => {
    const spend = new FakeSpend();
    let release: () => void = () => {};
    const { deps, waited } = fakeDeps({
      spend,
      reply: async function* () {
        yield { type: "text" as const, text: "first" };
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        yield { type: "text" as const, text: "never read" };
      },
    });
    const prepared = await prepareChatTurn(deps, { userId: ALICE, requestId: "r", request: send() });
    if (!prepared.ok) throw new Error("prepare failed");
    const reader = toNdjsonStream(streamChatTurn(deps, prepared.turn, new AbortController().signal)).getReader();
    await reader.read(); // start
    await reader.read(); // first delta
    const cancelled = reader.cancel();
    release();
    await cancelled;
    expect(spend.reservations[0]!.settled).toBe(spend.reservations[0]!.held);
    expect(waited).toHaveLength(1);
  });

  it("does not fail the reply when the settle fails", async () => {
    const spend = new FakeSpend();
    spend.settle = async () => {
      throw new Error("db down");
    };
    const { deps, logs } = fakeDeps({ spend });
    const { events } = await runTurn(deps, send());
    expect(events.at(-1)?.type).toBe("done");
    expect(logs.map((l) => l.event)).toContain("spend_settle_failed");
  });

  it.each([
    ["day", 429],
    ["user", 429],
    ["period", 503],
  ] as const)("refuses before streaming when the Nebius %s cap is reached", async (limit, status) => {
    const repo = new MemoryRepository();
    const spend = new FakeSpend();
    spend.refuse.nebius = limit;
    const { deps, prompts, searches } = fakeDeps({ repo, spend });

    const { prepared } = await runTurn(deps, send(true));

    expect(prepared).toMatchObject({ ok: false, status, code: "budget_exhausted" });
    expect(repo.conversations).toHaveLength(0);
    expect(repo.messages).toHaveLength(0);
    expect(prompts).toHaveLength(0);
    expect(searches).toHaveLength(0);
    expect(spend.reservations).toHaveLength(0);
  });

  it("checks the per-user quota first and spends no budget when it refuses", async () => {
    const spend = new FakeSpend();
    const { deps } = fakeDeps({ spend, quota: new FakeQuota(false) });
    const { prepared } = await runTurn(deps, send(true));
    expect(prepared).toMatchObject({ ok: false, code: "rate_limited" });
    expect(spend.reservations).toHaveLength(0);
  });

  it("fails closed when the budget cannot be checked", async () => {
    const repo = new MemoryRepository();
    const spend = new FakeSpend();
    spend.failReserve = true;
    const { deps, prompts } = fakeDeps({ repo, spend });
    await expect(runTurn(deps, send())).rejects.toThrow();
    expect(repo.messages).toHaveLength(0);
    expect(prompts).toHaveLength(0);
  });

  it("gives the holds back when the user message cannot be saved", async () => {
    const repo = new MemoryRepository();
    repo.failInsertForRole = "user";
    const spend = new FakeSpend();
    const { deps } = fakeDeps({ repo, spend, search: async () => [] });
    await expect(runTurn(deps, send(true))).rejects.toThrow();
    expect(spend.reservations.map((r) => [r.provider, r.settled])).toEqual([
      ["nebius", 0],
      ["tavily", 0],
    ]);
  });

  it("reserves one Tavily credit for a search, and none when search is off", async () => {
    const spend = new FakeSpend();
    const { deps } = fakeDeps({ spend, search: async () => [{ title: "T", url: "https://e.com/", excerpt: "E" }] });
    await runTurn(deps, send(true));
    expect(spend.reservations.filter((r) => r.provider === "tavily").map((r) => r.held)).toEqual([1]);
    expect(spend.counted("tavily")).toBe(1);

    const off = new FakeSpend();
    const second = fakeDeps({ spend: off });
    await runTurn(second.deps, send(false));
    expect(off.reservations.map((r) => r.provider)).toEqual(["nebius"]);
  });

  it("answers without search when only the Tavily budget is used up", async () => {
    const repo = new MemoryRepository();
    const spend = new FakeSpend();
    spend.refuse.tavily = "period";
    const { deps, searches, prompts, logs } = fakeDeps({ repo, spend, search: async () => [] });

    const { prepared, events } = await runTurn(deps, send(true));

    expect(prepared.ok).toBe(true);
    expect(searches).toHaveLength(0);
    expect(events.find((e) => e.type === "search")).toEqual({
      type: "search",
      status: "failed",
      sources: [],
      message: SEARCH_BUDGET_MESSAGE,
    });
    // The model is told that search failed, so it does not claim web grounding.
    expect(prompts[0]![0]!.content).toContain("the search failed");
    expect(prompts[0]!.at(-1)!.content).toBe("hi");
    expect(events.at(-1)).toMatchObject({ type: "done", message: { webSearch: "failed", sources: [] } });
    expect(repo.messages.at(-1)).toMatchObject({ role: "assistant", webSearch: "failed" });
    expect(logs.find((l) => l.event === "spend_limit_reached")?.fields).toMatchObject({ provider: "tavily" });
  });

  it("prices an unknown model at the most expensive rate", async () => {
    const known = new FakeSpend();
    await runTurn(fakeDeps({ spend: known }).deps, send());
    const unknown = new FakeSpend();
    await runTurn(fakeDeps({ spend: unknown, model: "someone/new-model" }).deps, send());
    expect(unknown.reservations[0]!.held).toBeGreaterThan(known.reservations[0]!.held);
    expect(unknown.reservations[0]!.settled).toBe(
      costMicroUsd(priceForModel("nvidia/Nemotron-3-Ultra-550b-a55b").price, { promptTokens: 10, completionTokens: 2 }),
    );
  });
});
