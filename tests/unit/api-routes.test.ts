import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { REPLY_CLAIM_LEASE_SECONDS } from "@/lib/limits";
import { ConfigError } from "@/lib/supabase-config";
import type { AuthContext } from "@/server/auth/session";
import { requestFingerprint } from "@/server/http/request-key";
import { readChatStream } from "@/features/chat/stream";
import {
  FakeContextRecords,
  FakeOwnData,
  FakeQuota,
  FakeSpend,
  MemoryRepository,
  TEST_SPEND_CAPS,
  fakeDeps,
  testEmbedder,
  testRouting,
} from "../support/fakes";
import { TITLE_MAX_OUTPUT_TOKENS } from "@/server/assistant/title";
import { titleFromMessage } from "@/server/assistant/context";
import type { CompletionChunk, ModelCallRequest, ModelProvider } from "@/server/providers/model";
import { createBarrier } from "../support/barrier";
import { fakeGoogle, json, TOKEN_URL } from "../support/fake-google";
import { sealText, tokenAssociatedData } from "@/server/google/crypto";
import type { ConnectedAccountRepository, GoogleTokenRow } from "@/server/db/connected-accounts";
import { collect } from "../support/streams";
import {
  ALL_WRITE_FAULTS,
  WriteFaults,
  describeCase,
  hasFault,
  sweepWriteFaults,
  type SweepCase,
  type WriteFault,
} from "../support/write-faults";

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
const { createConversationRepository, SchemaMissingError } = await import("@/server/db/conversations");
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
    nebius: { apiKey: "k", baseUrl: "https://nebius.test/v1" },
    routing: testRouting(),
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

  it("returns budget_exhausted before streaming when the daily spend cap is reached", async () => {
    signInAs(ALICE);
    const spend = new FakeSpend();
    spend.refuse.nebius = "day";
    vi.mocked(createAssistantDeps).mockReturnValue(fakeDeps({ repo, spend }).deps);
    const response = await chatRoute.POST(chatRequest({ action: "send", message: "hi", webSearch: false }));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBeTruthy();
    const body = await response.json();
    expect(body.error).toMatchObject({
      code: "budget_exhausted",
      message: "P-Dot has reached its daily usage limit. Try again tomorrow.",
    });
    expect(repo.messages).toHaveLength(0);
  });

  it("returns 500, not a reply, when the spend cap cannot be checked", async () => {
    signInAs(ALICE);
    const spend = new FakeSpend();
    spend.failReserve = true;
    vi.mocked(createAssistantDeps).mockReturnValue(fakeDeps({ repo, spend }).deps);
    const response = await chatRoute.POST(chatRequest({ action: "send", message: "hi", webSearch: false }));
    expect(response.status).toBe(500);
    expect(repo.messages).toHaveLength(0);
  });
});

/** A connected Google account in memory, for the google variants of the sweep (decision 0014). */
class SweepAccounts implements ConnectedAccountRepository {
  constructor(public row: GoogleTokenRow) {}
  async getGoogleConnection() {
    return { email: this.row.email, scopes: this.row.scopes, status: this.row.status };
  }
  async getGoogleToken() {
    return { ...this.row };
  }
  async saveGoogle() {}
  async markGoogleNeedsReconnect(_userId: string, ciphertext: string) {
    if (this.row.tokenCiphertext === ciphertext) this.row.status = "needs_reconnect";
  }
  async deleteGoogle() {
    return false;
  }
}

const SWEEP_KEY = new Uint8Array(32).fill(6);
const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

describe("POST /api/chat when one write fails", () => {
  const MESSAGE = "Plan my week";
  const KEY = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const LEASE_MS = REPLY_CLAIM_LEASE_SECONDS * 1000;
  type Variant = "new" | "existing" | "search" | "tools" | "google" | "google401";
  /** Asks for an email with the address, so the Google proposal guard allows it. */
  const GOOGLE_MESSAGE = "Email sam@example.com that I can come. Check the lunch email first.";

  /** The first pass reads Gmail and proposes the email; the next pass answers. */
  function googleModel() {
    const requests: ModelCallRequest[] = [];
    const provider: ModelProvider = {
      name: "nebius",
      stream(request) {
        requests.push(request);
        const isTitle = request.maxOutputTokens === TITLE_MAX_OUTPUT_TOKENS;
        const afterTools = request.messages.at(-1)?.role === "tool";
        return (async function* (): AsyncGenerator<CompletionChunk> {
          if (isTitle) yield { type: "text", text: "Lunch" };
          else if (request.tools?.some((tool) => tool.name === "propose_email") && !afterTools) {
            yield {
              type: "tool_calls",
              calls: [
                { id: "g1", name: "gmail_search", arguments: JSON.stringify({ query: "lunch" }) },
                { id: "g2", name: "propose_email", arguments: JSON.stringify({ to: ["sam@example.com"], subject: "Lunch", body: "I can come." }) },
              ],
            };
          } else yield { type: "text", text: "Approve the email below." };
          yield { type: "finish", finishReason: "stop", usage: { promptTokens: 10, completionTokens: 5 } };
        })();
      },
    };
    return { provider, requests };
  }
  /** Asks for a task and a memory, so the own-data tools are offered and the model calls two of them. */
  const TOOLS_MESSAGE = "Remember that I fly from BOM, and add a task to book flights";

  /**
   * A model for the tools variant: the first pass calls propose_task and
   * save_memory, the next pass answers, and a title call gets a title.
   */
  function toolModel() {
    const requests: ModelCallRequest[] = [];
    const provider: ModelProvider = {
      name: "nebius",
      stream(request) {
        requests.push(request);
        const isTitle = request.maxOutputTokens === TITLE_MAX_OUTPUT_TOKENS;
        const afterTools = request.messages.at(-1)?.role === "tool";
        return (async function* (): AsyncGenerator<CompletionChunk> {
          if (isTitle) yield { type: "text", text: "Flights from BOM" };
          else if (request.tools && !afterTools) {
            yield {
              type: "tool_calls",
              calls: [
                { id: "c1", name: "propose_task", arguments: JSON.stringify({ title: "Book flights" }) },
                { id: "c2", name: "save_memory", arguments: JSON.stringify({ content: "Flies from BOM" }) },
              ],
            };
          } else yield { type: "text", text: "Approve the task and keep the memory below." };
          yield { type: "finish", finishReason: "stop", usage: { promptTokens: 10, completionTokens: 5 } };
        })();
      },
    };
    return { provider, requests };
  }

  /**
   * One chat turn with faults, then recovery as the chat screen does it: a
   * resend of the same draft with the same request key, or "Retry reply". A
   * 409 "busy" means a claim is still live; the user tries again after the lease.
   */
  async function chatScenario(variant: Variant, faults: WriteFaults, sweepCase: SweepCase, strictRecord = false) {
    const at = `${variant} conversation, ${describeCase(sweepCase)}`;
    repo = new MemoryRepository();
    let clock = Date.UTC(2026, 9, 14, 12, 0, 0);
    repo.now = () => clock;
    const spend = new FakeSpend();
    const quota = new FakeQuota();
    const contextRecords = new FakeContextRecords();
    const existing = variant === "existing" ? await repo.createConversation(ALICE, "Earlier", "personal") : null;
    faults.wrap(repo, ["findMessageByClientRequest", "findConversationByClientRequest", "getMessage", "nextUserMessageAt"], { read: true });
    faults.wrap(repo, ["createConversation", "insertMessage", "claimReply", "releaseReplyClaim"], {
      detail: (method, args) => (method === "insertMessage" ? String((args[1] as { role: string }).role) : ""),
    });
    faults.wrap(spend, ["reserve", "settle"], {
      detail: (method, args) =>
        method === "reserve" ? String(args[0]) : (spend.reservations.find((r) => r.id === args[0])?.provider ?? "unknown"),
    });
    faults.wrap(quota, ["consume"]);
    faults.wrap(contextRecords, ["insertContextRecord"]);
    const google = variant === "google" || variant === "google401";
    const tools = variant === "tools" || google;
    const own = new FakeOwnData(ALICE, testEmbedder(spend), () => repo.messages.at(-1)?.createdAt ?? "2026-10-14T12:00:00.000Z");
    const ownData = own.services();
    const model = google ? googleModel() : toolModel();
    let accounts: SweepAccounts | null = null;
    const googleEndpoint = fakeGoogle({
      [TOKEN_URL]: () => json({ access_token: "at", expires_in: 3600 }),
      [`${GMAIL_API}/messages?`]: () =>
        variant === "google401" ? json({ error: { status: "UNAUTHENTICATED" } }, 401) : json({ messages: [{ id: "m1" }] }),
      [`${GMAIL_API}/messages/m1`]: () =>
        json({ id: "m1", threadId: "t", snippet: "Lunch on Friday?", payload: { headers: [{ name: "Subject", value: "Lunch" }] } }),
    });
    const endpoint = { fetch: googleEndpoint.fetch };
    if (google) {
      accounts = new SweepAccounts({
        subject: "sub-1",
        email: "me@example.com",
        scopes: ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.send"],
        status: "connected",
        tokenCiphertext: await sealText(SWEEP_KEY, "refresh-1", tokenAssociatedData(ALICE, "google")),
      });
      faults.wrap(accounts, ["getGoogleConnection", "getGoogleToken"], { label: "Accounts", read: true });
      faults.wrap(accounts, ["markGoogleNeedsReconnect"], { label: "Accounts" });
      faults.wrap(endpoint, ["fetch"], { label: "Google", read: true });
    }
    if (tools) {
      faults.wrap(repo, ["renameConversation"]);
      // Its spend writes are swept through FakeSpend; the call itself can only fail.
      faults.wrap(ownData.embedder, ["embed"], { label: "Embedder", read: true });
      faults.wrap(ownData.retrieval, ["matchMemories", "matchDocumentChunks"], { label: "Retrieval", read: true });
      faults.wrap(ownData.proposals, ["hasProposalBetween"], { label: "Proposals", read: true });
      faults.wrap(ownData.proposals, ["createProposal"], { label: "Proposals" });
      faults.wrap(ownData.memories, ["hasAssistantMemoryFrom"], { label: "Memories", read: true });
      faults.wrap(ownData.memories, ["createMemory"], { label: "Memories" });
    }
    const fake = fakeDeps({ repo, spend, quota, contextRecords, ...(tools ? { ownData, provider: model.provider } : {}) });
    if (tools) fake.deps.titles = true;
    if (google && accounts) {
      fake.deps.google = {
        config: { clientId: "id", clientSecret: "secret", encryptionKey: SWEEP_KEY, redirectUri: "http://localhost/cb" },
        accounts,
        proposals: ownData.proposals,
        fetch: (input, init) => endpoint.fetch(input, init),
      };
    }
    vi.mocked(createAssistantDeps).mockReturnValue(fake.deps);
    signInAs(ALICE);

    const webSearch = variant === "search";
    // A title event can follow done; the checks below look at the reply's own last event.
    const events = async (response: Response) => {
      const read = response.status === 200 ? await collect(readChatStream(response.body!)) : [];
      await Promise.all(fake.waited.splice(0));
      return read.filter((event) => event.type !== "title");
    };
    const send = () =>
      chatRoute.POST(
        chatRequest(
          {
            action: "send",
            message: google ? GOOGLE_MESSAGE : tools ? TOOLS_MESSAGE : MESSAGE,
            webSearch,
            ...(google ? { useGoogle: true as const } : {}),
            ...(existing ? { conversationId: existing.id } : {}),
          },
          { "Idempotency-Key": KEY },
        ),
      );
    const retry = (conversationId: string) =>
      chatRoute.POST(chatRequest({ action: "retry", conversationId, webSearch, ...(google ? { useGoogle: true as const } : {}) }));
    const afterBusy = async (request: () => Promise<Response>) => {
      const response = await request();
      if (response.status !== 409 || (await response.clone().json()).error.code !== "busy") return response;
      clock += LEASE_MS + 1000;
      return request();
    };

    const first = await send();
    const firstEvents = await events(first);
    faults.disarm();
    await faults.flushDelayed();
    const started = firstEvents.find((e) => e.type === "start");
    const done = firstEvents.some((e) => e.type === "done");
    if (!started) expect(first.status, `${at}: an error before the stream`).toBeGreaterThanOrEqual(500);
    if (started && !done) expect(firstEvents.at(-1)?.type, at).toBe("error");

    if (!started) {
      const again = await events(await afterBusy(send));
      expect(again.at(-1)?.type, `${at}: resend`).toBe("done");
    } else if (!done) {
      const conversationId = started.type === "start" ? started.conversation.id : "";
      const retried = await afterBusy(() => retry(conversationId));
      const retriedEvents = await events(retried);
      if (retried.status === 409) expect((await retried.json()).error.code, `${at}: retry`).toBe("answered");
      else expect(retriedEvents.at(-1)?.type, `${at}: retry`).toBe("done");
    }

    const spendFaults = faults.fired.filter((f) => f.label.startsWith("FakeSpend")).length;
    const openNebius = spend.reservations.filter((r) => r.provider === "nebius" && r.settled === null).length;
    expect(openNebius, `${at}: only a failed spend write leaves a Nebius hold counted`).toBeLessThanOrEqual(spendFaults);
    // A search that was sent keeps its Tavily credit (decision 0006).
    const openTavily = spend.reservations.filter((r) => r.provider === "tavily" && r.settled === null).length;
    expect(openTavily, `${at}: Tavily holds`).toBeLessThanOrEqual(fake.searches.length + spendFaults);
    if (webSearch) expect(spend.reservations.some((r) => r.provider === "tavily"), `${at}: search spend`).toBe(true);

    const mine = repo.conversations.filter((c) => c.userId === ALICE);
    const target = existing ?? mine.at(-1);
    const thread = repo.messages.filter((m) => m.conversationId === target?.id);
    const reply = thread.at(-1);
    expect(reply?.role, `${at}: the last message has its reply`).toBe("assistant");
    expect(mine, `${at}: no extra conversation`).toHaveLength(1);
    expect(thread.map((m) => m.role), `${at}: one message and one reply`).toEqual(["user", "assistant"]);
    expect(fake.calls.length, `${at}: at most one provider call for each claim`).toBeLessThanOrEqual(quota.calls);

    if (google) {
      // Proposing never calls a Google write API, and a retry or resend never repeats a proposal.
      expect(googleEndpoint.calls.filter((c) => c.method !== "GET" && c.url !== TOKEN_URL), `${at}: no Google write`).toEqual([]);
      expect(own.proposals.length, `${at}: at most one proposal`).toBeLessThanOrEqual(1);
      expect(own.proposals.every((p) => p.status === "proposed" && p.payload.kind === "send_email"), `${at}: proposal`).toBe(true);
      expect(googleEndpoint.calls.filter((c) => c.url === TOKEN_URL).length, `${at}: one refresh for each turn`).toBeLessThanOrEqual(quota.calls);
      // The 401 reached the tool only when the Gmail list call was answered.
      const got401 = variant === "google401" && googleEndpoint.calls.some((c) => c.url.startsWith(`${GMAIL_API}/messages?`));
      // An outage in an earlier attempt lets that attempt propose; the 401 comes in a later retry.
      const outageFirst = sweepCase.some((f) => f.label === "Accounts.getGoogleToken" || f.label === "Google.fetch");
      if (got401) {
        if (!outageFirst) expect(own.proposals, `${at}: a credential that ended stops the propose tool`).toHaveLength(0);
        const markFailed = sweepCase.some((f) => f.label === "Accounts.markGoogleNeedsReconnect" && f.fault === "refused");
        if (!markFailed) expect(accounts!.row.status, `${at}: the row is marked`).toBe("needs_reconnect");
      } else if (variant === "google401") {
        expect(accounts!.row.status, `${at}: no 401, no mark`).toBe("connected");
      } else if (!sweepCase.some((f) => /^(Proposals|Accounts|Google|Embedder|Retrieval|FakeSpend)\./.test(f.label))) {
        expect(own.proposals, `${at}: the proposal is saved`).toHaveLength(1);
      }
    } else if (tools) {
      // Tool hops and the title are extra calls; each claim still starts at most one first pass.
      const firstPasses = model.requests.filter(
        (r) => r.maxOutputTokens !== TITLE_MAX_OUTPUT_TOKENS && r.messages.at(-1)?.role !== "tool",
      );
      expect(firstPasses.length, `${at}: at most one first pass for each claim`).toBeLessThanOrEqual(quota.calls);
      // A retry or resend never repeats a proposal or a memory, and nothing stays in another status.
      expect(own.proposals.length, `${at}: at most one proposal`).toBeLessThanOrEqual(1);
      expect(own.memories.length, `${at}: at most one suggested memory`).toBeLessThanOrEqual(1);
      expect(own.proposals.every((p) => p.status === "proposed" && p.conversationId === target?.id), `${at}: proposal`).toBe(true);
      expect(own.memories.every((m) => m.status === "proposed" && m.source === "assistant"), `${at}: memory`).toBe(true);
      const ownFaults = sweepCase.some((f) => /^(Proposals|Memories|Embedder|Retrieval|FakeSpend)\./.test(f.label));
      if (!ownFaults) {
        expect(own.proposals, `${at}: the proposal is saved`).toHaveLength(1);
        expect(own.memories, `${at}: the memory is saved`).toHaveLength(1);
      }
      const title = mine[0]?.title;
      expect(["Flights from BOM", titleFromMessage(TOOLS_MESSAGE)], `${at}: a whole title`).toContain(title);
    }

    const records = contextRecords.records.filter((r) => r.messageId === reply?.id);
    // A refused record write only logs a warning (decision 0009). A reply whose save could not be
    // confirmed in its own request (lost or delayed insert, refused read-back) has no record.
    const replySaveUnconfirmed = ["lost", "delayed"].some((fault) =>
      hasFault(sweepCase, fault as WriteFault, "MemoryRepository.insertMessage:assistant"),
    );
    const recordMayBeMissing =
      hasFault(sweepCase, "refused", "FakeContextRecords.insertContextRecord") ||
      hasFault(sweepCase, "delayed", "FakeContextRecords.insertContextRecord") ||
      (!strictRecord && replySaveUnconfirmed);
    if (!recordMayBeMissing) expect(records, `${at}: one "what was sent" record for the reply`).toHaveLength(1);
    expect(records.length, at).toBeLessThanOrEqual(1);
    expect(contextRecords.records.length, `${at}: no record without a saved reply`).toBeLessThanOrEqual(1);
  }

  it.each(["new", "existing", "search", "tools", "google", "google401"] as const)(
    "%s conversation: every write and read, up to two faults, ends with one message, its reply and its record",
    async (variant) => {
      const cases = await sweepWriteFaults((faults, sweepCase) => chatScenario(variant, faults, sweepCase), {
        faults: ALL_WRITE_FAULTS,
        maxCases: 1500,
      });
      const labels = new Set(cases.map((c) => c.at(-1)!.label));
      for (const label of [
        "MemoryRepository.findMessageByClientRequest",
        "FakeQuota.consume",
        "FakeSpend.reserve:nebius",
        "MemoryRepository.insertMessage:user",
        "MemoryRepository.insertMessage:assistant",
        "FakeSpend.settle:nebius",
        "FakeContextRecords.insertContextRecord",
        ...(variant === "existing" ? [] : ["MemoryRepository.findConversationByClientRequest", "MemoryRepository.createConversation"]),
        ...(variant === "search" ? ["FakeSpend.reserve:tavily"] : []),
        ...(variant === "tools"
          ? ["Proposals.createProposal", "Memories.createMemory", "Embedder.embed", "MemoryRepository.renameConversation"]
          : []),
        ...(variant === "google" ? ["Proposals.createProposal", "Accounts.getGoogleConnection", "Accounts.getGoogleToken", "Google.fetch"] : []),
        ...(variant === "google401" ? ["Accounts.markGoogleNeedsReconnect", "Accounts.getGoogleToken"] : []),
      ]) {
        expect(labels, label).toContain(label);
      }
    },
    // More than 1,000 runs each; under a full parallel `npm test` this takes longer than the 5 s default.
    60_000,
  );

  type Earlier = "none" | "proposal" | "memory";

  /**
   * "Retry reply" of a saved user message whose first attempt saved no reply,
   * with faults armed, so the repeat's reads of earlier rows can fail. Then a
   * further "Retry reply" when the turn has no reply yet. The first attempt
   * left `earlier`: nothing, the task proposal, or the suggested memory.
   */
  async function repeatScenario(earlier: Earlier, faults: WriteFaults, sweepCase: SweepCase) {
    const at = `repeat after ${earlier}, ${describeCase(sweepCase)}`;
    const store = new MemoryRepository();
    let clock = Date.UTC(2026, 9, 14, 12, 0, 0);
    store.now = () => clock;
    const spend = new FakeSpend();
    const quota = new FakeQuota();
    const contextRecords = new FakeContextRecords();
    const own = new FakeOwnData(ALICE, testEmbedder(spend), () => store.messages.at(-1)?.createdAt ?? "2026-10-14T12:00:00.000Z");
    const ownData = own.services();
    const conversation = await store.createConversation(ALICE, "Flights", "personal");
    const saved = await store.insertMessage(ALICE, { conversationId: conversation.id, role: "user", content: TOOLS_MESSAGE });
    if (earlier === "proposal") {
      await ownData.proposals.createProposal(ALICE, {
        conversationId: conversation.id,
        payload: { kind: "create_task", mode: "personal", title: "Book flights" },
        summary: 'Add the task "Book flights".',
      });
    }
    if (earlier === "memory") {
      await ownData.memories.createMemory(
        ALICE,
        { mode: "personal", content: "Flies from BOM", status: "proposed", source: "assistant", sourceMessageId: saved.id },
        null,
      );
    }
    const before = { proposals: own.proposals.length, memories: own.memories.length };

    faults.wrap(store, ["getMessage", "nextUserMessageAt"], { read: true });
    faults.wrap(store, ["insertMessage", "claimReply", "releaseReplyClaim"], {
      detail: (method, args) => (method === "insertMessage" ? String((args[1] as { role: string }).role) : ""),
    });
    faults.wrap(spend, ["reserve", "settle"], {
      detail: (method, args) =>
        method === "reserve" ? String(args[0]) : (spend.reservations.find((r) => r.id === args[0])?.provider ?? "unknown"),
    });
    faults.wrap(quota, ["consume"]);
    faults.wrap(contextRecords, ["insertContextRecord"]);
    faults.wrap(ownData.embedder, ["embed"], { label: "Embedder", read: true });
    faults.wrap(ownData.retrieval, ["matchMemories", "matchDocumentChunks"], { label: "Retrieval", read: true });
    faults.wrap(ownData.proposals, ["hasProposalBetween"], { label: "Proposals", read: true });
    faults.wrap(ownData.proposals, ["createProposal"], { label: "Proposals" });
    faults.wrap(ownData.memories, ["hasAssistantMemoryFrom"], { label: "Memories", read: true });
    faults.wrap(ownData.memories, ["createMemory"], { label: "Memories" });
    const model = toolModel();
    const fake = fakeDeps({ repo: store, spend, quota, contextRecords, ownData, provider: model.provider });
    vi.mocked(createAssistantDeps).mockReturnValue(fake.deps);
    vi.mocked(createConversationRepository).mockReturnValue(store);
    signInAs(ALICE);

    const retry = async () => {
      let response = await chatRoute.POST(chatRequest({ action: "retry", conversationId: conversation.id, webSearch: false }));
      if (response.status === 409 && (await response.clone().json()).error.code === "busy") {
        clock += LEASE_MS + 1000;
        response = await chatRoute.POST(chatRequest({ action: "retry", conversationId: conversation.id, webSearch: false }));
      }
      const events = response.status === 200 ? await collect(readChatStream(response.body!)) : [];
      await Promise.all(fake.waited.splice(0));
      return { response, events };
    };

    const first = await retry();
    faults.disarm();
    await faults.flushDelayed();
    const done = first.events.some((e) => e.type === "done");
    if (first.events.length === 0) expect(first.response.status, `${at}: an error before the stream`).toBeGreaterThanOrEqual(500);
    else if (!done) expect(first.events.at(-1)?.type, at).toBe("error");

    if (!done) {
      const again = await retry();
      if (again.response.status === 409) expect((await again.response.json()).error.code, `${at}: further retry`).toBe("answered");
      else expect(again.events.at(-1)?.type, `${at}: further retry`).toBe("done");
    }

    const thread = store.messages.filter((m) => m.conversationId === conversation.id);
    expect(thread.map((m) => m.role), `${at}: one message and one reply`).toEqual(["user", "assistant"]);
    if (earlier === "none") {
      expect(own.proposals.length, `${at}: at most one proposal`).toBeLessThanOrEqual(1);
      expect(own.memories.length, `${at}: at most one memory`).toBeLessThanOrEqual(1);
      const ownFaults = sweepCase.some((f) => /^(Proposals|Memories|Embedder|Retrieval|FakeSpend|MemoryRepository\.nextUserMessageAt)/.test(f.label));
      if (!ownFaults) expect([own.proposals.length, own.memories.length], `${at}: the repeat wrote both`).toEqual([1, 1]);
    } else {
      expect({ proposals: own.proposals.length, memories: own.memories.length }, `${at}: the first attempt's rows only`).toEqual(before);
    }
  }

  it.each(["none", "proposal", "memory"] as const)(
    "Retry reply after a first attempt that left %s: every write and read, up to two faults, writes no second card",
    async (earlier) => {
      const cases = await sweepWriteFaults((faults, sweepCase) => repeatScenario(earlier, faults, sweepCase), {
        faults: ALL_WRITE_FAULTS,
        maxCases: 1500,
      });
      const labels = new Set(cases.map((c) => c.at(-1)!.label));
      const reads =
        earlier === "memory"
          ? ["Memories.hasAssistantMemoryFrom"]
          : ["Memories.hasAssistantMemoryFrom", "MemoryRepository.nextUserMessageAt", "Proposals.hasProposalBetween"];
      for (const label of [...reads, "MemoryRepository.claimReply", "MemoryRepository.insertMessage:assistant"]) {
        expect(labels, label).toContain(label);
      }
      if (earlier === "none") expect(labels).toContain("Proposals.createProposal");
    },
    60_000,
  );

  it.each([
    ["new", "refused", "MemoryRepository.insertMessage:user", "leaves an empty conversation"],
    ["new", "lost", "MemoryRepository.createConversation", "leaves an empty conversation"],
    ["new", "lost", "MemoryRepository.insertMessage:user", "leaves a second conversation with the same message"],
    ["existing", "lost", "MemoryRepository.insertMessage:user", "saves the user message twice"],
  ] as const)("%s conversation, %s %s, then a resend with the same key: no longer %s", async (variant, fault, label, _defect) => {
    void _defect;
    const dry = new WriteFaults();
    await chatScenario(variant, dry, []);
    const step = dry.calls.indexOf(label) + 1;
    expect(step).toBeGreaterThan(0);
    await chatScenario(variant, new WriteFaults().fail(fault, step), [{ step, fault, label }]);
  });

  it("a lost response on the reply write: the reply is read back by its ID and gets its record", async () => {
    const label = "MemoryRepository.insertMessage:assistant";
    const dry = new WriteFaults();
    await chatScenario("existing", dry, []);
    const step = dry.calls.indexOf(label) + 1;
    await chatScenario("existing", new WriteFaults().fail("lost", step), [{ step, fault: "lost", label }], true);
  });
});

describe("POST /api/chat with a request key (decision 0012)", () => {
  const KEY = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  const keyed = { "Idempotency-Key": KEY };
  const send = (body: Record<string, unknown> = {}, headers: Record<string, string> = keyed) =>
    chatRoute.POST(chatRequest({ action: "send", message: "Plan my week", webSearch: false, ...body }, headers));
  const errorOf = async (response: Response) => (await response.json()).error as { code: string; conversationId?: string };

  /** A provider that waits at a barrier before it answers, so a second request can overlap the first. */
  function heldTurn(options: { search?: boolean } = {}) {
    const barrier = createBarrier();
    const quota = new FakeQuota();
    const spend = new FakeSpend();
    const fake = fakeDeps({
      repo,
      quota,
      spend,
      ...(options.search ? { search: async () => [] } : {}),
      reply: async function* () {
        await barrier.wait();
        yield { type: "text" as const, text: "Here is your week." };
        yield { type: "finish" as const, finishReason: "stop", usage: { promptTokens: 10, completionTokens: 5 } };
      },
    });
    vi.mocked(createAssistantDeps).mockReturnValue(fake.deps);
    return { barrier, quota, spend, fake };
  }

  beforeEach(() => signInAs(ALICE));

  it("a resend and a Retry reply while the first reply is still running get 409 busy, and only one reply is made", async () => {
    const { barrier, quota, spend, fake } = heldTurn();
    const first = await send();
    const reading = collect(readChatStream(first.body!));
    await barrier.reached;
    const conversationId = repo.conversations[0]!.id;

    const resend = await send();
    expect(resend.status).toBe(409);
    expect(await errorOf(resend)).toMatchObject({ code: "busy", conversationId });
    const retry = await chatRoute.POST(chatRequest({ action: "retry", conversationId, webSearch: false }));
    expect(retry.status).toBe(409);
    expect((await errorOf(retry)).code).toBe("busy");

    barrier.release();
    expect((await reading).at(-1)?.type).toBe("done");
    await Promise.all(fake.waited);
    expect(repo.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(fake.calls).toHaveLength(1);
    expect(quota.calls).toBe(1);
    expect(spend.reservations.every((r) => r.settled !== null)).toBe(true);

    const after = await send();
    expect(after.status).toBe(409);
    expect(await errorOf(after)).toMatchObject({ code: "answered", conversationId });
  });

  it("two sends with one key that both miss the lookup save one conversation, one message and one reply", async () => {
    const barrier = createBarrier(2);
    const quota = new FakeQuota();
    const consume = quota.consume.bind(quota);
    quota.consume = async () => {
      await barrier.wait();
      return consume();
    };
    const spend = new FakeSpend();
    const fake = fakeDeps({ repo, quota, spend });
    vi.mocked(createAssistantDeps).mockReturnValue(fake.deps);

    const a = send();
    const b = send();
    await barrier.reached;
    barrier.release();
    const [first, second] = await Promise.all([a, b]);
    const answers = await Promise.all(
      [first, second].map(async (response) => (response.status === 200 ? (await collect(readChatStream(response.body!))).at(-1)?.type : response.status)),
    );
    await Promise.all(fake.waited);
    expect(answers.sort()).toEqual([500, "done"].sort());
    expect(repo.conversations).toHaveLength(1);
    expect(repo.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(fake.calls).toHaveLength(1);
    expect(quota.calls).toBe(2);
    expect(spend.reservations.every((r) => r.settled !== null)).toBe(true);
  });

  it("a claim whose lease ended can be claimed again", async () => {
    let clock = Date.UTC(2026, 9, 21, 12, 0, 0);
    repo.now = () => clock;
    const conversation = await repo.createConversation(ALICE, "Stopped", "personal");
    await repo.insertMessage(ALICE, { conversationId: conversation.id, role: "user", content: "Hi", replyClaimId: "dead-worker" });
    const fake = fakeDeps({ repo });
    vi.mocked(createAssistantDeps).mockReturnValue(fake.deps);
    const retry = () => chatRoute.POST(chatRequest({ action: "retry", conversationId: conversation.id, webSearch: false }));

    expect((await retry()).status).toBe(409);
    clock += REPLY_CLAIM_LEASE_SECONDS * 1000 + 1;
    const events = await collect(readChatStream((await retry()).body!));
    expect(events.at(-1)?.type).toBe("done");
  });

  it("a reply that the reply link refuses ends with an error event, and no second reply is saved", async () => {
    const { barrier, fake } = heldTurn();
    const response = await send();
    const reading = collect(readChatStream(response.body!));
    await barrier.reached;
    const question = repo.messages[0]!;
    // Another request saved a reply after this claim's lease ended.
    await repo.insertMessage(ALICE, { conversationId: question.conversationId, role: "assistant", content: "Late", replyTo: question.id });
    barrier.release();
    expect((await reading).at(-1)).toMatchObject({ type: "error", code: "internal_error" });
    await Promise.all(fake.waited);
    expect(repo.messages.map((m) => m.content)).toEqual(["Plan my week", "Late"]);
  });

  it("refuses a key that was used for another text, conversation or mode with 409 conflict, before quota", async () => {
    const quota = new FakeQuota();
    const fake = fakeDeps({ repo, quota });
    vi.mocked(createAssistantDeps).mockReturnValue(fake.deps);
    expect((await send({ mode: "personal" })).status).toBe(200);
    const other = await repo.createConversation(ALICE, "Other", "personal");
    for (const body of [{ message: "Something else" }, { conversationId: other.id }, { mode: "work" }]) {
      const response = await send(body);
      expect(response.status).toBe(409);
      expect((await errorOf(response)).code).toBe("conflict");
    }
    expect(quota.calls).toBe(1);
    expect(repo.messages.filter((m) => m.role === "user")).toHaveLength(1);
  });

  it("checks the fingerprint when only the conversation with the key exists", async () => {
    const quota = new FakeQuota();
    vi.mocked(createAssistantDeps).mockReturnValue(fakeDeps({ repo, quota }).deps);
    const hash = await requestFingerprint(["chat.send.v1", "new:personal", "Another draft"]);
    await repo.createConversation(ALICE, "Another draft", "personal", { clientRequest: { id: KEY, hash } });

    const response = await send();
    expect(response.status).toBe(409);
    expect((await errorOf(response)).code).toBe("conflict");
    expect(quota.calls).toBe(0);
    expect(repo.messages).toHaveLength(0);
  });

  it("uses an empty conversation with the key, and refuses one that already has messages", async () => {
    vi.mocked(createAssistantDeps).mockReturnValue(fakeDeps({ repo }).deps);
    const hash = await requestFingerprint(["chat.send.v1", "new:personal", "Plan my week"]);
    const empty = await repo.createConversation(ALICE, "Plan my week", "personal", { clientRequest: { id: KEY, hash } });
    expect((await collect(readChatStream((await send()).body!))).at(-1)?.type).toBe("done");
    expect(repo.conversations).toHaveLength(1);
    expect(repo.messages.map((m) => m.conversationId)).toEqual([empty.id, empty.id]);

    repo = new MemoryRepository();
    vi.mocked(createAssistantDeps).mockReturnValue(fakeDeps({ repo }).deps);
    const used = await repo.createConversation(ALICE, "Plan my week", "personal", { clientRequest: { id: KEY, hash } });
    await repo.insertMessage(ALICE, { conversationId: used.id, role: "user", content: "Another message" });
    const response = await send();
    expect(response.status).toBe(409);
    expect((await errorOf(response)).code).toBe("conflict");
  });

  it("answers 409 answered for a saved message that is no longer the last one", async () => {
    vi.mocked(createAssistantDeps).mockReturnValue(fakeDeps({ repo }).deps);
    const hash = await requestFingerprint(["chat.send.v1", "new:personal", "Plan my week"]);
    const conversation = await repo.createConversation(ALICE, "Plan my week", "personal");
    await repo.insertMessage(ALICE, { conversationId: conversation.id, role: "user", content: "Plan my week", clientRequest: { id: KEY, hash } });
    await repo.insertMessage(ALICE, { conversationId: conversation.id, role: "user", content: "Later message" });
    const response = await send();
    expect(response.status).toBe(409);
    expect(await errorOf(response)).toMatchObject({ code: "answered", conversationId: conversation.id });
  });

  it("refuses a key that is not a UUID before any work", async () => {
    const response = await send({}, { "Idempotency-Key": "not-a-uuid" });
    expect(response.status).toBe(400);
    expect(createAssistantDeps).not.toHaveBeenCalled();
  });

  it("does no lookup without a key", async () => {
    const lookup = vi.spyOn(repo, "findMessageByClientRequest");
    const response = await send({}, {});
    expect((await collect(readChatStream(response.body!))).at(-1)?.type).toBe("done");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("does not find another user's key: Bob's send with Alice's key makes Bob's own rows", async () => {
    vi.mocked(createAssistantDeps).mockReturnValue(fakeDeps({ repo }).deps);
    await collect(readChatStream((await send()).body!));
    signInAs(BOB);
    await collect(readChatStream((await send()).body!));
    expect(repo.conversations.map((c) => c.userId)).toEqual([ALICE, BOB]);
    expect(repo.messages.filter((m) => m.userId === BOB).map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it.each([false, true])(
    "gives back the holds and ends the claim when the stream is cancelled before its first read (web search: %s)",
    async (search) => {
      const spend = new FakeSpend();
      const fake = fakeDeps({ repo, spend, ...(search ? { search: async () => [] } : {}) });
      vi.mocked(createAssistantDeps).mockReturnValue(fake.deps);
      const response = await send({ webSearch: search });
      expect(response.status).toBe(200);
      await response.body!.cancel();
      await Promise.all(fake.waited);

      expect(spend.reservations.map((r) => [r.provider, r.settled])).toEqual(
        search ? [["nebius", 0], ["tavily", 0]] : [["nebius", 0]],
      );
      expect(fake.waited.length).toBeGreaterThan(0);
      expect(repo.claimOf(repo.messages[0]!.id)).toBeNull();
      expect(fake.calls).toHaveLength(0);
    },
  );

  it("a lost reservation response, then a resend: one reply, and only that hold stays counted", async () => {
    const spend = new FakeSpend();
    const faults = new WriteFaults().fail("lost", 1);
    faults.wrap(spend, ["reserve"]);
    const fake = fakeDeps({ repo, spend });
    vi.mocked(createAssistantDeps).mockReturnValue(fake.deps);
    expect((await send()).status).toBe(500);
    faults.disarm();
    expect((await collect(readChatStream((await send()).body!))).at(-1)?.type).toBe("done");
    await Promise.all(fake.waited);
    expect(repo.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(spend.reservations.filter((r) => r.settled === null)).toHaveLength(1);
  });

  it.each([
    ["the key lookup", "findMessageByClientRequest", async () => () => send()],
    ["the claim of Retry reply", "claimReply", async () => {
      const conversation = await repo.createConversation(ALICE, "t", "personal");
      await repo.insertMessage(ALICE, { conversationId: conversation.id, role: "user", content: "Hi" });
      return () => chatRoute.POST(chatRequest({ action: "retry", conversationId: conversation.id, webSearch: false }));
    }],
  ] as const)("fails closed with schema_missing when %s finds no new column or function", async (_label, method, setUp) => {
    const quota = new FakeQuota();
    const spend = new FakeSpend();
    const fake = fakeDeps({ repo, quota, spend });
    vi.mocked(createAssistantDeps).mockReturnValue(fake.deps);
    const run = await setUp();
    vi.spyOn(repo, method).mockRejectedValue(new SchemaMissingError(method));
    const before = repo.messages.length;

    const response = await run();
    expect(response.status).toBe(500);
    const logged = vi.mocked(console.error).mock.calls.map((call) => JSON.parse(String(call[0])));
    expect(logged).toContainEqual(expect.objectContaining({ event: "schema_missing", route: "chat" }));
    expect(quota.calls).toBe(0);
    expect(spend.reservations).toHaveLength(0);
    expect(repo.messages.length).toBe(before);
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
