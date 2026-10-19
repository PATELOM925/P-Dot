import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ConfigError } from "@/lib/supabase-config";
import type { AuthContext } from "@/server/auth/session";
import { readChatStream } from "@/features/chat/stream";
import { FakeQuota, MemoryRepository, TEST_SPEND_CAPS, fakeDeps } from "../support/fakes";
import { collect } from "../support/streams";

vi.mock("@/server/auth/session", () => ({ getAuthContext: vi.fn() }));
vi.mock("@/server/config", () => ({ getAssistantConfig: vi.fn(), getSiteUrl: () => "http://localhost:3000" }));
vi.mock("@/server/assistant/deps", () => ({ createAssistantDeps: vi.fn() }));
vi.mock("@/server/db/conversations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/db/conversations")>()),
  createConversationRepository: vi.fn(),
}));

const { getAuthContext } = await import("@/server/auth/session");
const { getAssistantConfig } = await import("@/server/config");
const { createAssistantDeps } = await import("@/server/assistant/deps");
const { createConversationRepository } = await import("@/server/db/conversations");
const chatRoute = await import("@/app/api/chat/route");
const listRoute = await import("@/app/api/conversations/route");
const itemRoute = await import("@/app/api/conversations/[id]/route");

const ALICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BOB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function signInAs(userId: string | null) {
  vi.mocked(getAuthContext).mockResolvedValue(
    userId ? ({ userId, email: `${userId}@example.com`, supabase: {} as SupabaseClient } satisfies AuthContext) : null,
  );
}

function chatRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { host: "localhost", origin: "http://localhost", "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function itemRequest(method: string, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/conversations/x", {
    method,
    headers: { host: "localhost", origin: "http://localhost", ...headers },
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

let repo: MemoryRepository;

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  repo = new MemoryRepository();
  vi.mocked(createConversationRepository).mockReturnValue(repo);
  vi.mocked(getAssistantConfig).mockReturnValue({
    nebius: { apiKey: "k", baseUrl: "https://nebius.test/v1", model: "m", maxOutputTokens: 256 },
    tavily: null,
    quota: { requestsPerWindow: 30, windowSeconds: 3600 },
    spend: TEST_SPEND_CAPS,
  });
  vi.mocked(createAssistantDeps).mockReturnValue(fakeDeps({ repo }).deps);
});

describe("POST /api/chat", () => {
  it("rejects signed-out requests before touching providers", async () => {
    signInAs(null);
    const response = await chatRoute.POST(chatRequest({ action: "send", message: "hi", webSearch: false }));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "unauthorized" } });
    expect(createAssistantDeps).not.toHaveBeenCalled();
  });

  it("rejects cross-origin browser requests", async () => {
    signInAs(ALICE);
    const response = await chatRoute.POST(
      chatRequest({ action: "send", message: "hi", webSearch: false }, { origin: "https://evil.example" }),
    );
    expect(response.status).toBe(403);
    expect(getAuthContext).not.toHaveBeenCalled();
  });

  it.each([
    ["non-JSON content type", "hello", { "content-type": "text/plain" }, 415, "unsupported_media_type"],
    ["oversized body", { action: "send", message: "x".repeat(20_000), webSearch: false }, {}, 413, "payload_too_large"],
    ["malformed JSON", "{", {}, 400, "invalid_request"],
    ["schema violation", { action: "send", message: "", webSearch: false }, {}, 400, "invalid_request"],
    ["client-supplied user ID", { action: "send", message: "hi", webSearch: false, userId: BOB }, {}, 400, "invalid_request"],
  ])("rejects %s", async (_label, body, headers, status, code) => {
    signInAs(ALICE);
    const response = await chatRoute.POST(chatRequest(body, headers as Record<string, string>));
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: { code } });
    expect(createAssistantDeps).not.toHaveBeenCalled();
  });

  it("returns 503 without details when inference is not configured", async () => {
    signInAs(ALICE);
    vi.mocked(getAssistantConfig).mockImplementation(() => {
      throw new ConfigError(["NEBIUS_API_KEY"]);
    });
    const response = await chatRoute.POST(chatRequest({ action: "send", message: "hi", webSearch: false }));
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(text).toContain("not_configured");
    expect(text).not.toContain("NEBIUS_API_KEY");
  });

  it("streams NDJSON events for the session user", async () => {
    signInAs(ALICE);
    const response = await chatRoute.POST(chatRequest({ action: "send", message: "hi", webSearch: false }));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const events = await collect(readChatStream(response.body!));
    expect(events.map((e) => e.type)).toEqual(["start", "delta", "delta", "done"]);
    expect(repo.conversations[0]!.userId).toBe(ALICE);
  });

  it("returns 404 when posting into another user's conversation", async () => {
    const theirs = await repo.createConversation(ALICE, "private");
    signInAs(BOB);
    const response = await chatRoute.POST(
      chatRequest({ action: "send", conversationId: theirs.id, message: "hi", webSearch: false }),
    );
    expect(response.status).toBe(404);
    expect(repo.messages).toHaveLength(0);
  });

  it("returns 429 with Retry-After when over the usage limit", async () => {
    signInAs(ALICE);
    vi.mocked(createAssistantDeps).mockReturnValue(fakeDeps({ repo, quota: new FakeQuota(false) }).deps);
    const response = await chatRoute.POST(chatRequest({ action: "send", message: "hi", webSearch: false }));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBeTruthy();
  });
});

describe("/api/conversations", () => {
  it("requires a session", async () => {
    signInAs(null);
    expect((await listRoute.GET(itemRequest("GET"))).status).toBe(401);
    expect((await itemRoute.GET(itemRequest("GET"), params(ALICE))).status).toBe(401);
    expect((await itemRoute.DELETE(itemRequest("DELETE"), params(ALICE))).status).toBe(401);
  });

  it("lists only the signed-in user's conversations", async () => {
    await repo.createConversation(ALICE, "Alice 1");
    await repo.createConversation(BOB, "Bob 1");
    signInAs(ALICE);
    const body = await (await listRoute.GET(itemRequest("GET"))).json();
    expect(body.conversations.map((c: { title: string }) => c.title)).toEqual(["Alice 1"]);
  });

  it("returns a conversation with its messages to its owner", async () => {
    const own = await repo.createConversation(ALICE, "Mine");
    await repo.insertMessage(ALICE, { conversationId: own.id, role: "user", content: "hello" });
    signInAs(ALICE);
    const response = await itemRoute.GET(itemRequest("GET"), params(own.id));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: own.id, title: "Mine", messages: [{ content: "hello" }] });
  });

  it("hides other users' conversations behind 404, including malformed IDs", async () => {
    const theirs = await repo.createConversation(ALICE, "Alice private");
    signInAs(BOB);
    expect((await itemRoute.GET(itemRequest("GET"), params(theirs.id))).status).toBe(404);
    expect((await itemRoute.GET(itemRequest("GET"), params("../../etc"))).status).toBe(404);
  });

  it("does not let one user delete another user's conversation", async () => {
    const theirs = await repo.createConversation(ALICE, "Alice private");
    signInAs(BOB);
    const response = await itemRoute.DELETE(itemRequest("DELETE"), params(theirs.id));
    expect(response.status).toBe(404);
    expect(repo.conversations).toHaveLength(1);
  });

  it("deletes the owner's conversation and its messages", async () => {
    const own = await repo.createConversation(ALICE, "Mine");
    await repo.insertMessage(ALICE, { conversationId: own.id, role: "user", content: "hello" });
    signInAs(ALICE);
    const response = await itemRoute.DELETE(itemRequest("DELETE"), params(own.id));
    expect(response.status).toBe(204);
    expect(repo.conversations).toHaveLength(0);
    expect(repo.messages).toHaveLength(0);
  });

  it("rejects cross-origin deletes", async () => {
    const own = await repo.createConversation(ALICE, "Mine");
    signInAs(ALICE);
    const response = await itemRoute.DELETE(itemRequest("DELETE", { origin: "https://evil.example" }), params(own.id));
    expect(response.status).toBe(403);
    expect(repo.conversations).toHaveLength(1);
  });

  it("returns JSON 500 without internals when storage fails", async () => {
    signInAs(ALICE);
    vi.spyOn(repo, "listConversations").mockRejectedValue(new Error("connection string postgres://secret"));
    const response = await listRoute.GET(itemRequest("GET"));
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).toContain("internal_error");
    expect(text).not.toContain("secret");
  });
});
