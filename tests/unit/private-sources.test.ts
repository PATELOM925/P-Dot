import { describe, expect, it } from "vitest";
import { chatRequestSchema } from "@/lib/schemas";
import { prepareChatTurn } from "@/server/assistant/service";
import { checkToolCall, TOOLS, type ToolSpec } from "@/server/assistant/tools";
import type { RouteReason } from "@/lib/routing";
import { FakeSpend, MemoryRepository, fakeDeps } from "../support/fakes";

// One source for each message, and no model-written web search after a
// private source (decision 0014, decision 10; decision 0016).

const ALICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const spec = (name: string) => TOOLS.find((tool) => tool.name === name)!;

describe("one source for each message, in the request schema", () => {
  const base = { action: "send", message: "hi", webSearch: false } as const;

  it.each([
    ["web search and Google", { webSearch: true, useGoogle: true }],
    ["web search and an app", { webSearch: true, connectors: ["notion"] }],
    ["Google and an app", { useGoogle: true, connectors: ["notion"] }],
    ["all three", { webSearch: true, useGoogle: true, connectors: ["linear"] }],
  ])("refuses %s, for a send and for a retry", (_name, extra) => {
    expect(chatRequestSchema.safeParse({ ...base, ...extra }).success).toBe(false);
    expect(
      chatRequestSchema.safeParse({ action: "retry", conversationId: "c0000000-0000-4000-8000-000000000001", webSearch: false, ...extra })
        .success,
    ).toBe(false);
  });

  it.each([
    ["web search", { webSearch: true }],
    ["Google", { useGoogle: true }],
    ["one app", { connectors: ["notion"] }],
    ["several apps, which are one source", { connectors: ["notion", "linear", "todoist"] }],
    ["nothing", {}],
  ])("accepts %s alone", (_name, extra) => {
    expect(chatRequestSchema.safeParse({ ...base, ...extra }).success).toBe(true);
  });
});

describe("checkToolCall refuses a turn that mixes sources", () => {
  const callOf = (name: string, args: unknown) => ({ id: "c1", name, arguments: JSON.stringify(args) });
  const connector = TOOLS.find((tool) => tool.source === "connector")!;

  it.each([
    ["web search and Google", [spec("web_search"), spec("gmail_search")], callOf("gmail_search", { query: "x" })],
    ["Google and an app", [spec("gmail_search"), connector], callOf("gmail_search", { query: "x" })],
    ["web search and an app", [spec("web_search"), connector], callOf("web_search", { query: "x" })],
  ])("%s", (_name, offered, call) => {
    const checked = checkToolCall(offered as ToolSpec[], call, new Map());
    expect(checked).toEqual({ ok: false, content: "This request mixes outside sources, which is not allowed. Nothing was done." });
  });

  it("allows one source with the user's own P-Dot tools", () => {
    const checked = checkToolCall([spec("gmail_search"), spec("propose_task")], callOf("gmail_search", { query: "x" }), new Map());
    expect(checked.ok).toBe(true);
  });

  it("tags every outside source", () => {
    expect(spec("web_search").source).toBe("web");
    for (const name of ["gmail_search", "gmail_read", "calendar_list_events", "propose_email", "propose_calendar_event"]) {
      expect(spec(name).source).toBe("google");
    }
    expect(TOOLS.filter((tool) => tool.source === "connector").length).toBeGreaterThan(0);
  });
});

describe("no model-written web search after a private source, in both directions", () => {
  async function conversationWith(reason: RouteReason | null) {
    const repo = new MemoryRepository();
    const conversation = await repo.createConversation(ALICE, "Earlier", "personal");
    await repo.insertMessage(ALICE, { conversationId: conversation.id, role: "user", content: "earlier" });
    await repo.insertMessage(ALICE, {
      conversationId: conversation.id,
      role: "assistant",
      content: "earlier reply",
      ...(reason ? { route: { model: "m", tier: "standard", reason, fallback: false } } : {}),
    });
    return { repo, conversation };
  }

  async function prepare(repo: MemoryRepository, conversationId: string) {
    const { deps } = fakeDeps({ repo, spend: new FakeSpend(), search: async () => [] });
    const prepared = await prepareChatTurn(deps, {
      userId: ALICE,
      requestId: "r",
      request: { action: "send", conversationId, message: "news?", webSearch: true },
    });
    if (!prepared.ok) throw new Error(prepared.code);
    return prepared.turn;
  }

  it.each([
    ["a Google reply", "google_request" as const],
    ["an app reply", "connector_read" as const],
  ])("after %s: the first search with the user's words still runs, but the model gets no web_search tool", async (_name, reason) => {
    const { repo, conversation } = await conversationWith(reason);
    const turn = await prepare(repo, conversation.id);
    expect(turn.webSearch).toBe(true);
    expect(turn.toolFlags.webSearchTool).toBe(false);
  });

  it("a failed check counts as used", async () => {
    const { repo, conversation } = await conversationWith(null);
    repo.failPrivateSourceCheck = true;
    expect((await prepare(repo, conversation.id)).toolFlags.webSearchTool).toBe(false);
  });

  it("a clean conversation keeps the tool", async () => {
    const { repo, conversation } = await conversationWith(null);
    expect((await prepare(repo, conversation.id)).toolFlags.webSearchTool).toBe(true);
  });
});
