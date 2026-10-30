import { describe, expect, it } from "vitest";
import { prepareChatTurn, streamChatTurn, type AssistantDeps } from "@/server/assistant/service";
import { nebiusHoldMicroUsd } from "@/server/assistant/spend";
import { selectTools, TOOLS, toToolDefinition } from "@/server/assistant/tools";
import type { CompletionChunk, ModelCallRequest, ModelProvider, ToolCall } from "@/server/providers/model";
import type { ChatRequest, ChatStreamEvent } from "@/types/api";
import { buildRoutingConfig } from "@/server/assistant/tiers";
import { FakeProvider } from "../support/fake-provider";
import { FakeContextRecords, FakeSpend, MemoryRepository, fakeDeps } from "../support/fakes";
import { MAX_ASSISTANT_CHARS } from "@/lib/limits";
import { collect } from "../support/streams";

const ALICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SUPER = "nvidia/nemotron-3-super-120b-a12b";

type Step = { text?: string; calls?: ToolCall[] };

/** A provider that answers each call with the next step; the last step repeats. */
function scripted(steps: Step[]) {
  const requests: ModelCallRequest[] = [];
  const provider: ModelProvider = {
    name: "nebius",
    stream(request) {
      requests.push(request);
      const step = steps[Math.min(requests.length - 1, steps.length - 1)]!;
      return (async function* (): AsyncGenerator<CompletionChunk> {
        if (step.text) yield { type: "text", text: step.text };
        if (step.calls) {
          yield { type: "tool_progress" };
          yield { type: "tool_calls", calls: step.calls };
        }
        yield { type: "finish", finishReason: step.calls ? "tool_calls" : "stop", usage: { promptTokens: 100, completionTokens: 10 } };
      })();
    },
  };
  return { provider, requests };
}

const search = (query: string, id = "c1"): ToolCall => ({ id, name: "web_search", arguments: JSON.stringify({ query }) });

const page = (n: number) => ({ title: `Page ${n}`, url: `https://example.com/${n}`, excerpt: `Fact ${n}.` });

async function runTurn(deps: AssistantDeps, request: ChatRequest) {
  const prepared = await prepareChatTurn(deps, { userId: ALICE, requestId: "req-1", request });
  if (!prepared.ok) throw new Error(`refused: ${prepared.code}`);
  const events = await collect(streamChatTurn(deps, prepared.turn, new AbortController().signal));
  return { turn: prepared.turn, events };
}

function setup(steps: Step[], options: { spend?: FakeSpend; results?: (query: string) => ReturnType<typeof page>[] } = {}) {
  const repo = new MemoryRepository();
  const spend = options.spend ?? new FakeSpend();
  const { provider, requests } = scripted(steps);
  const fake = fakeDeps({ repo, spend, provider, search: async (query) => (options.results ?? (() => [page(1)]))(query) });
  return { ...fake, repo, spend, requests };
}

const ofType = <T extends ChatStreamEvent["type"]>(events: ChatStreamEvent[], type: T) =>
  events.filter((event): event is Extract<ChatStreamEvent, { type: T }> => event.type === type);

describe("tool loop", () => {
  it("offers no tools and makes one call when web search is off", async () => {
    const { deps, requests, spend } = setup([{ text: "Hi." }]);

    const { events } = await runTurn(deps, { action: "send", message: "hello", webSearch: false });

    expect(requests).toHaveLength(1);
    expect(requests[0]).not.toHaveProperty("tools");
    expect(requests[0]!.messages[0]!.content).toContain("You cannot browse");
    expect(ofType(events, "done")).toHaveLength(1);
    expect(spend.reservations.filter((r) => r.provider === "tavily")).toHaveLength(0);
  });

  it("offers web_search only when the user turned search on", async () => {
    const { deps, requests } = setup([{ text: "Answer [1]." }]);

    await runTurn(deps, { action: "send", message: "news?", webSearch: true });

    expect(requests[0]!.tools?.map((tool) => tool.name)).toEqual(["web_search"]);
    expect(requests[0]!.messages[0]!.content).toContain("only through the tools offered");
  });

  it("runs one more search, shows its status, numbers its sources after the first ones, and saves all sources", async () => {
    const { deps, requests, searches, repo, spend } = setup(
      [{ calls: [search("tokyo weather today")] }, { text: "Sunny [2]." }],
      { results: (query) => (query === "tokyo weather today" ? [page(1), page(2)] : [page(1)]) },
    );

    const { events } = await runTurn(deps, { action: "send", message: "Weather in Tokyo?", webSearch: true });

    expect(searches).toEqual(["Weather in Tokyo?", "tokyo weather today"]);
    expect(ofType(events, "status")).toEqual([{ type: "status", tool: "web_search", query: "tokyo weather today" }]);
    expect(requests).toHaveLength(2);
    const second = requests[1]!.messages;
    expect(second.at(-2)).toMatchObject({ role: "assistant", toolCalls: [search("tokyo weather today")] });
    const toolResult = second.at(-1)!;
    expect(toolResult).toMatchObject({ role: "tool", toolCallId: "c1" });
    // page(1) was already a source, so only page(2) is new, as source 2.
    expect(toolResult.content).toContain('<source id="2">');
    expect(toolResult.content).not.toContain("https://example.com/1");
    expect(toolResult.content).toContain("Untrusted reference material");

    const reply = repo.messages.find((m) => m.role === "assistant")!;
    expect(reply.content).toBe("Sunny [2].");
    expect(reply.webSearch).toBe("used");
    expect(reply.sources.map((s) => s.url)).toEqual(["https://example.com/1", "https://example.com/2"]);
    expect(spend.reservations.filter((r) => r.provider === "tavily")).toHaveLength(2);
  });

  it("stops at 2 tool hops, turns tools off on the final pass, and searches at most once by tool", async () => {
    const { deps, requests, searches } = setup([
      { calls: [search("a", "c1")] },
      { calls: [search("b", "c2")] },
      { text: "Done." },
    ]);

    const { events } = await runTurn(deps, { action: "send", message: "q", webSearch: true });

    expect(requests).toHaveLength(3);
    expect(requests.map((r) => r.tools?.length ?? 0)).toEqual([1, 1, 0]);
    expect(searches).toEqual(["q", "a"]);
    expect(requests[2]!.messages.at(-1)!.content).toContain("limit for web_search in this turn is reached");
    expect(ofType(events, "done")[0]!.message.content).toBe("Done.");
  });

  it("holds and settles spend for every hop, pricing the tools and the tool results", async () => {
    const { deps, requests, spend } = setup([{ calls: [search("x")] }, { text: "Done." }]);

    await runTurn(deps, { action: "send", message: "q", webSearch: true });

    const nebius = spend.reservations.filter((r) => r.provider === "nebius");
    expect(nebius).toHaveLength(2);
    expect(nebius.every((r) => r.settled !== null)).toBe(true);
    const tools = selectTools(TOOLS, { webSearch: true, ownData: false, webSearchTool: true, google: null }).map(toToolDefinition);
    expect(nebius[1]!.held).toBe(nebiusHoldMicroUsd(SUPER, requests[1]!.messages, 1024, 0, tools));
    expect(nebius[1]!.held).toBeGreaterThan(nebiusHoldMicroUsd(SUPER, requests[1]!.messages, 1024));
  });

  it("stops with budget_exhausted when a later hop's hold is refused, and saves nothing", async () => {
    const spend = new FakeSpend();
    const { deps, repo, requests } = setup([{ calls: [search("x")] }, { text: "never" }], { spend });
    const reserve = spend.reserve.bind(spend);
    spend.reserve = async (provider, amount) => {
      if (provider === "nebius" && spend.reservations.some((r) => r.provider === "nebius")) return { allowed: false, limit: "user" };
      return reserve(provider, amount);
    };

    const { events, turn } = await runTurn(deps, { action: "send", message: "q", webSearch: true });

    expect(requests).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "error", code: "budget_exhausted", retryable: false });
    expect(repo.messages.filter((m) => m.role === "assistant")).toHaveLength(0);
    expect(spend.reservations.filter((r) => r.provider === "nebius").every((r) => r.settled !== null)).toBe(true);
    expect(repo.claimOf(turn.userMessage.id)).toBeNull();
  });

  it("refuses arguments that fail the schema, without a search or a status event", async () => {
    const bad: ToolCall = { id: "c1", name: "web_search", arguments: JSON.stringify({ query: "" }) };
    const { deps, requests, searches } = setup([{ calls: [bad, { id: "c2", name: "send_email", arguments: "{" }] }, { text: "OK." }]);

    const { events } = await runTurn(deps, { action: "send", message: "q", webSearch: true });

    expect(searches).toEqual(["q"]);
    expect(ofType(events, "status")).toHaveLength(0);
    const results = requests[1]!.messages.filter((m) => m.role === "tool").map((m) => m.content);
    expect(results[0]).toContain("arguments were not valid (query)");
    expect(results[1]).toContain("not available in this request");
  });

  it("offers no tool when the search budget refused the search", async () => {
    const spend = new FakeSpend();
    spend.refuse.tavily = "day";
    const { deps, requests } = setup([{ text: "OK." }], { spend });

    await runTurn(deps, { action: "send", message: "q", webSearch: true });

    expect(requests[0]).not.toHaveProperty("tools");
  });

  it("keeps the text of two hops apart in the reply", async () => {
    const { deps, repo } = setup([{ text: "Let me check.", calls: [search("x")] }, { text: "It is 5." }]);

    await runTurn(deps, { action: "send", message: "q", webSearch: true });

    expect(repo.messages.find((m) => m.role === "assistant")!.content).toBe("Let me check.\n\nIt is 5.");
  });

  it("gives every hop only the time left of one deadline", async () => {
    const { deps, requests } = setup([{ calls: [search("x")] }, { text: "OK." }]);

    await runTurn(deps, { action: "send", message: "q", webSearch: true });

    const deadline = deps.routing.standard.deadlineMs;
    expect(requests.every((r) => r.timeoutMs <= deadline)).toBe(true);
    expect(requests[1]!.timeoutMs).toBeLessThanOrEqual(requests[0]!.timeoutMs);
  });

  it("logs tool names only, never queries or arguments", async () => {
    const { deps, logs } = setup([{ calls: [search("secret plan"), { id: "c2", name: "secret tool", arguments: "{}" }] }, { text: "OK." }]);

    await runTurn(deps, { action: "send", message: "q", webSearch: true });

    const logged = JSON.stringify(logs);
    expect(logged).not.toContain("secret");
    expect(logs.some((l) => l.event === "tool_call_refused" && l.fields.tool === "unknown")).toBe(true);
  });

  it("never switches model in a later hop after text is visible: it stops on the same model's error", async () => {
    const LIGHTNING = "nvidia/Nemotron-3_5-Lightning";
    const provider = new FakeProvider({
      [SUPER]: [{ chunks: [{ text: "Let me check." }], toolCalls: [search("x")] }, { status: 404 }],
      [LIGHTNING]: [{ chunks: [{ text: "Other model." }] }],
    });
    const chains = { fast: [SUPER, LIGHTNING], standard: [SUPER, LIGHTNING], heavy: [SUPER, LIGHTNING], vision: [SUPER] };
    const routing = buildRoutingConfig({
      chains,
      maxOutputTokens: 1024,
      standardMaxOutputTokens: 1024,
      heavyMaxOutputTokens: 1024,
      heavyThinkingBudgetTokens: 0,
      hedgeAfterMs: 0,
    });
    const repo = new MemoryRepository();
    const { deps } = fakeDeps({ repo, provider, routing, search: async () => [page(1)] });

    const { events } = await runTurn(deps, { action: "send", message: "q", webSearch: true });

    expect(provider.callsTo(SUPER)).toHaveLength(2);
    expect(provider.callsTo(LIGHTNING)).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ type: "error" });
    expect(ofType(events, "delta").map((e) => e.text).join("")).toBe("Let me check.");
    expect(repo.messages.filter((m) => m.role === "assistant")).toHaveLength(0);
  });

  it("may still use the next model in a later hop when no text was visible", async () => {
    const LIGHTNING = "nvidia/Nemotron-3_5-Lightning";
    const provider = new FakeProvider({
      [SUPER]: [{ chunks: [], toolCalls: [search("x")] }, { status: 404 }],
      [LIGHTNING]: [{ chunks: [{ text: "Answer." }] }],
    });
    const routing = buildRoutingConfig({
      chains: { fast: [SUPER, LIGHTNING], standard: [SUPER, LIGHTNING], heavy: [SUPER, LIGHTNING], vision: [SUPER] },
      maxOutputTokens: 1024,
      standardMaxOutputTokens: 1024,
      heavyMaxOutputTokens: 1024,
      heavyThinkingBudgetTokens: 0,
      hedgeAfterMs: 0,
    });
    const repo = new MemoryRepository();
    const { deps } = fakeDeps({ repo, provider, routing, search: async () => [page(1)] });

    const { events } = await runTurn(deps, { action: "send", message: "q", webSearch: true });

    expect(ofType(events, "done")[0]!.message).toMatchObject({ content: "Answer.", route: { model: LIGHTNING, fallback: true } });
  });

  it("gives back the tool search credit when Stop comes while the credit is held", async () => {
    const spend = new FakeSpend();
    const controller = new AbortController();
    const reserve = spend.reserve.bind(spend);
    spend.reserve = async (provider, amount) => {
      const result = await reserve(provider, amount);
      if (provider === "tavily" && spend.reservations.filter((r) => r.provider === "tavily").length === 2) controller.abort();
      return result;
    };
    const { deps, searches, waited } = setup([{ calls: [search("x")] }, { text: "never" }], { spend });

    const prepared = await prepareChatTurn(deps, { userId: ALICE, requestId: "req-1", request: { action: "send", message: "q", webSearch: true } });
    if (!prepared.ok) throw new Error("refused");
    await collect(streamChatTurn(deps, prepared.turn, controller.signal));
    await Promise.all(waited);

    const tavily = spend.reservations.filter((r) => r.provider === "tavily");
    expect(searches).toEqual(["q"]);
    expect(tavily).toHaveLength(2);
    expect(tavily[1]!.settled).toBe(0);
  });

  it("records no token sum when a later hop is cut at the length limit", async () => {
    const contextRecords = new FakeContextRecords();
    const { provider } = scripted([{ calls: [search("x")] }, { text: "y".repeat(MAX_ASSISTANT_CHARS + 10) }]);
    const { deps, waited } = fakeDeps({ provider, contextRecords, search: async () => [page(1)] });

    const { events } = await runTurn(deps, { action: "send", message: "q", webSearch: true });
    await Promise.all(waited);

    expect(ofType(events, "done")[0]!.truncated).toBe(true);
    expect(contextRecords.records[0]).toMatchObject({ inputTokens: null, outputTokens: null });
  });
});
