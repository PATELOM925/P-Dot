import { describe, expect, it } from "vitest";
import { chatRequestSchema } from "@/lib/schemas";
import { prepareChatTurn } from "@/server/assistant/service";
import { checkToolCall, TOOLS, type ToolSpec } from "@/server/assistant/tools";
import type { RouteReason } from "@/lib/routing";
import { FakeSpend, MemoryRepository, fakeDeps } from "../support/fakes";

// Web search, Google and apps can be on together, but no model-written web
// search runs with a private source, or after one in the conversation
// (decision 0014, decision 10; decision 0016; decision 0021).

const ALICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONVERSATION = "c0000000-0000-4000-8000-000000000001";
const spec = (name: string) => TOOLS.find((tool) => tool.name === name)!;

describe("sources for each message, in the request schema", () => {
  const send = (extra: Record<string, unknown>) => chatRequestSchema.safeParse({ action: "send", message: "hi", webSearch: false, ...extra }).success;
  const retry = (extra: Record<string, unknown>) =>
    chatRequestSchema.safeParse({ action: "retry", conversationId: CONVERSATION, webSearch: false, ...extra }).success;

  it.each([
    ["nothing", {}],
    ["web search", { webSearch: true }],
    ["Google", { useGoogle: true }],
    ["one app", { connectors: ["notion"] }],
    ["all apps", { connectors: ["notion", "linear", "todoist", "github"] }],
    ["web search and Google", { webSearch: true, useGoogle: true }],
    ["web search and an app", { webSearch: true, connectors: ["notion"] }],
    ["Google and an app", { useGoogle: true, connectors: ["notion"] }],
    ["Google and all apps", { useGoogle: true, connectors: ["notion", "linear", "todoist", "github"] }],
    ["web search, Google and apps", { webSearch: true, useGoogle: true, connectors: ["linear", "github"] }],
    ["deep research alone", { webSearch: true, research: true }],
  ])("accepts %s, for a send and for a retry", (_name, extra) => {
    expect(send(extra)).toBe(true);
    expect(retry(extra)).toBe(true);
  });

  it.each([
    ["deep research with Google", { webSearch: true, research: true, useGoogle: true }],
    ["deep research with an app", { webSearch: true, research: true, connectors: ["notion"] }],
    ["deep research with Google and an app", { webSearch: true, research: true, useGoogle: true, connectors: ["linear"] }],
    ["deep research without web search", { research: true }],
    ["one app twice", { connectors: ["notion", "notion"] }],
    ["an app that is not in the catalog", { connectors: ["vercel"] }],
  ])("refuses %s, for a send and for a retry", (_name, extra) => {
    expect(send(extra)).toBe(false);
    expect(retry(extra)).toBe(false);
  });

  it("says why deep research is refused with a private source", () => {
    const parsed = chatRequestSchema.safeParse({ action: "send", message: "hi", webSearch: true, research: true, useGoogle: true });
    expect(parsed.success).toBe(false);
    expect(parsed.error!.issues[0]).toMatchObject({
      path: ["research"],
      message: "Deep research cannot be used with Google or connected apps. Turn them off, or use Search the web.",
    });
  });
});

describe("checkToolCall refuses the model-written web search with a private source", () => {
  const callOf = (name: string, args: unknown) => ({ id: "c1", name, arguments: JSON.stringify(args) });
  const connector = TOOLS.find((tool) => tool.source === "connector")!;
  const refusal = { ok: false, content: "This request offers web search with Google or an app, which is not allowed. Nothing was done." };

  it.each([
    ["web search and Google, a Google call", [spec("web_search"), spec("gmail_search")], callOf("gmail_search", { query: "x" })],
    ["web search and Google, a search call", [spec("web_search"), spec("gmail_search")], callOf("web_search", { query: "x" })],
    ["web search and an app", [spec("web_search"), connector], callOf("web_search", { query: "x" })],
    ["web search, Google and an app", [spec("web_search"), spec("gmail_search"), connector], callOf("gmail_search", { query: "x" })],
  ])("%s", (_name, offered, call) => {
    expect(checkToolCall(offered as ToolSpec[], call, new Map())).toEqual(refusal);
  });

  it("allows Google and apps together", () => {
    const checked = checkToolCall([spec("gmail_search"), connector], callOf("gmail_search", { query: "x" }), new Map());
    expect(checked.ok).toBe(true);
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
