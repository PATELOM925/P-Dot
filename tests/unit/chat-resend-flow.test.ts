import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readChatStream } from "@/features/chat/stream";
import { ApiError } from "@/lib/api-client";
import { REQUEST_KEY_HEADER } from "@/lib/request-key";
import type { AuthContext } from "@/server/auth/session";
import { createBarrier } from "../support/barrier";
import { FakeQuota, FakeSpend, MemoryRepository, TEST_SPEND_CAPS, fakeDeps, testRouting } from "../support/fakes";
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
const conversationRoute = await import("@/app/api/conversations/[id]/route");
const { fetchConversation, postChat } = await import("@/features/chat/api");
const { ChatSendKey } = await import("@/features/chat/send-key");

const ALICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

/** The browser's fetch, sent to the route handlers in this process. */
async function routeFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const path = String(input);
  const request = new Request(`http://localhost${path}`, {
    ...init,
    headers: { ...(init.headers as Record<string, string>), host: "localhost", origin: "http://localhost" },
  });
  if (path === "/api/chat") return chatRoute.POST(request);
  const conversation = /^\/api\/conversations\/([^/]+)$/.exec(path);
  if (conversation) return conversationRoute.GET(request, { params: Promise.resolve({ id: conversation[1]! }) });
  throw new Error(`no route for ${path}`);
}

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(routeFetch));
  vi.mocked(getAuthContext).mockResolvedValue({
    userId: ALICE,
    email: "alice@example.com",
    supabase: {} as SupabaseClient,
  } satisfies AuthContext);
  vi.mocked(getAssistantConfig).mockReturnValue({
    nebius: { apiKey: "k", baseUrl: "https://nebius.test/v1" },
    routing: testRouting(),
    tavily: null,
    quota: { requestsPerWindow: 30, windowSeconds: 3600 },
    spend: TEST_SPEND_CAPS,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the chat screen and the route, when a response is lost while P-Dot still replies", () => {
  it("keeps the key and the draft on busy, then reconciles on answered: one message, one reply, one paid call", async () => {
    const repo = new MemoryRepository();
    vi.mocked(createConversationRepository).mockReturnValue(repo);
    const barrier = createBarrier();
    const quota = new FakeQuota();
    const spend = new FakeSpend();
    const fake = fakeDeps({
      repo,
      quota,
      spend,
      reply: async function* () {
        await barrier.wait();
        yield { type: "text" as const, text: "Here is your week." };
        yield { type: "finish" as const, finishReason: "stop", usage: { promptTokens: 10, completionTokens: 5 } };
      },
    });
    vi.mocked(createAssistantDeps).mockReturnValue(fake.deps);

    const sendKey = new ChatSendKey();
    let draft = "Plan my week";
    const body = { action: "send" as const, message: draft, webSearch: false, mode: "personal" as const };
    const send = () => postChat(body, new AbortController().signal, sendKey.headers({ mode: "personal" }, draft));
    const firstKey = sendKey.headers({ mode: "personal" }, draft)[REQUEST_KEY_HEADER];

    // 1. The first request is accepted, but its response never reaches the screen. The server goes on.
    const serverSide = collect(readChatStream(await send()));
    await barrier.reached;
    expect(sendKey.refused(new ApiError(0, "network_error", "Could not reach the server."))).toBeNull();

    // 2. The user sends the same draft again while P-Dot is still replying.
    const busy = await send().catch((error: unknown) => error);
    expect(busy).toBeInstanceOf(ApiError);
    expect(sendKey.refused(busy)).toBe("busy");
    expect((busy as ApiError).message).toBe("P-Dot is still replying. Try again in a few minutes.");
    expect(sendKey.headers({ mode: "personal" }, draft)[REQUEST_KEY_HEADER]).toBe(firstKey);

    // 3. The first request saves its reply.
    barrier.release();
    expect((await serverSide).at(-1)?.type).toBe("done");
    await Promise.all(fake.waited);

    // 4. The user tries again: the message was already sent. The screen reloads and reconciles.
    const answered = await send().catch((error: unknown) => error);
    expect(sendKey.refused(answered)).toBe("answered");
    const conversationId = (answered as ApiError).conversationId!;
    expect(conversationId).toBe(repo.conversations[0]!.id);
    const detail = await fetchConversation(conversationId);
    if (sendKey.reconcile(detail.messages, draft)) draft = "";
    expect(draft).toBe("");
    expect(detail.messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "Plan my week"],
      ["assistant", "Here is your week."],
    ]);

    expect(repo.conversations).toHaveLength(1);
    expect(repo.messages).toHaveLength(2);
    expect(fake.calls).toHaveLength(1);
    expect(quota.calls).toBe(1);
    expect(spend.reservations.every((r) => r.settled !== null)).toBe(true);
    // The same words sent later are a new message with a new key.
    expect(sendKey.headers({ conversationId }, "Plan my week")[REQUEST_KEY_HEADER]).not.toBe(firstKey);
  });

  it("two sends with one key to a new conversation: the late one gets answered, not conflict, and the draft is not sent twice", async () => {
    const repo = new MemoryRepository();
    vi.mocked(createConversationRepository).mockReturnValue(repo);
    const quota = new FakeQuota();
    const spend = new FakeSpend();
    const fake = fakeDeps({ repo, quota, spend });
    vi.mocked(createAssistantDeps).mockReturnValue(fake.deps);

    // B's first key lookup misses, then B waits there while A saves everything.
    const barrier = createBarrier();
    const lookup = repo.findMessageByClientRequest.bind(repo);
    let held = false;
    repo.findMessageByClientRequest = async (userId, key) => {
      const found = await lookup(userId, key);
      if (!held) {
        held = true;
        await barrier.wait();
      }
      return found;
    };

    const sendKey = new ChatSendKey();
    let draft = "Plan my week";
    const body = { action: "send" as const, message: draft, webSearch: false, mode: "personal" as const };
    const headers = sendKey.headers({ mode: "personal" }, draft);
    const late = postChat(body, new AbortController().signal, headers).catch((error: unknown) => error);
    await barrier.reached;

    const first = await collect(readChatStream(await postChat(body, new AbortController().signal, headers)));
    expect(first.at(-1)?.type).toBe("done");
    barrier.release();

    const refused = await late;
    expect(refused).toBeInstanceOf(ApiError);
    expect(sendKey.refused(refused)).toBe("answered");
    const detail = await fetchConversation((refused as ApiError).conversationId!);
    if (sendKey.reconcile(detail.messages, draft)) draft = "";
    expect(draft).toBe("");
    await Promise.all(fake.waited);

    expect(repo.conversations).toHaveLength(1);
    expect(repo.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(fake.calls).toHaveLength(1);
    expect(quota.calls).toBe(1);
    expect(spend.reservations.every((r) => r.settled !== null)).toBe(true);
  });
});
