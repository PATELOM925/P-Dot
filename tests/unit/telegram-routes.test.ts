import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AuthContext } from "@/server/auth/session";
import { TEST_KEY } from "../support/fake-mcp";
import { BOT_TOKEN, BOT_USERNAME, FakeTelegramLinks, WEBHOOK_SECRET, fakeBot, type FakeBot } from "../support/fake-telegram";
import { sweepWriteFaults } from "../support/write-faults";

vi.mock("@/server/auth/session", () => ({ getAuthContext: vi.fn() }));
vi.mock("@/server/db/telegram-links", () => ({ createTelegramLinkRepository: vi.fn() }));
vi.mock("@/server/db/quota", () => ({ createQuotaGate: vi.fn() }));

const { getAuthContext } = await import("@/server/auth/session");
const { createTelegramLinkRepository } = await import("@/server/db/telegram-links");
const { createQuotaGate } = await import("@/server/db/quota");
const linkRoute = await import("@/app/api/connectors/telegram/link/route");
const confirmRoute = await import("@/app/api/connectors/telegram/confirm/route");
const unlinkRoute = await import("@/app/api/connectors/telegram/unlink/route");
const sendRoute = await import("@/app/api/connectors/telegram/send/route");
const webhookRoute = await import("@/app/api/telegram/webhook/route");
const { hashLinkCode, openChat, sealLinkProof } = await import("@/server/telegram/seal");

/** Decision 0020: link, confirm, unlink and the approved send. */
const SITE = "https://pdot.example";
const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const CHAT_ID = 777001;
const TEXT = "Your brief: three meetings today.";

let links: FakeTelegramLinks;
let bot: FakeBot;
let quotaAllowed: boolean;
let quotaCalls: number;
let logs: string[];

class Quota {
  async consume() {
    quotaCalls += 1;
    return { allowed: quotaAllowed, resetsAt: new Date(Date.now() + 60_000) };
  }
}
let quota: Quota;

function signInAs(userId: string, isAnonymous = false) {
  vi.mocked(getAuthContext).mockResolvedValue({ userId, email: null, isAnonymous, supabase: {} as SupabaseClient } satisfies AuthContext);
  vi.mocked(createTelegramLinkRepository).mockImplementation(() => links.as(userId));
}

const headers = { host: "pdot.example", origin: SITE };
const postJson = (path: string, body: unknown, extra: Record<string, string> = {}) =>
  new Request(`${SITE}${path}`, { method: "POST", headers: { ...headers, "content-type": "application/json", ...extra }, body: JSON.stringify(body) });
const postForm = (path: string, form: Record<string, string | string[]> = {}) => {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(form)) for (const item of [value].flat()) body.append(key, item);
  return new Request(`${SITE}${path}`, { method: "POST", headers: { ...headers, "content-type": "application/x-www-form-urlencoded" }, body });
};
const outcome = (response: Response) => new URL(response.headers.get("location")!).searchParams.get("telegram");

const link = () => linkRoute.POST(postJson("/api/connectors/telegram/link", {}));
const confirm = (t: string | string[]) => confirmRoute.POST(postForm("/api/connectors/telegram/confirm", { t }));
const send = (text: string, key: string = crypto.randomUUID()) => sendRoute.POST(postJson("/api/connectors/telegram/send", { text, key }));

/** Starts a link as the signed-in user and returns the proof that the webhook gives for it. */
async function proofFor(chatId = CHAT_ID, name = "Om") {
  const response = await link();
  expect(response.status).toBe(200);
  const { deepLink } = (await response.json()) as { deepLink: string };
  const code = new URL(deepLink).searchParams.get("start")!;
  const update = { update_id: 1, message: { chat: { id: chatId, type: "private" }, from: { is_bot: false, first_name: name }, text: `/start ${code}` } };
  const hook = await webhookRoute.POST(
    new Request(`${SITE}/api/telegram/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": WEBHOOK_SECRET },
      body: JSON.stringify(update),
    }),
  );
  const reply = (await hook.json()) as { reply_markup: { inline_keyboard: { url: string }[][] } };
  return new URL(reply.reply_markup.inline_keyboard[0]![0]!.url).searchParams.get("t")!;
}

async function linkChat(userId = ALICE, chatId = CHAT_ID) {
  signInAs(userId);
  expect(outcome(await confirm(await proofFor(chatId)))).toBe("linked");
}

beforeEach(() => {
  links = new FakeTelegramLinks();
  bot = fakeBot();
  quotaAllowed = true;
  quotaCalls = 0;
  quota = new Quota();
  vi.mocked(createQuotaGate).mockImplementation(() => quota);
  vi.stubEnv("SITE_URL", SITE);
  vi.stubEnv("NEBIUS_API_KEY", "test-key");
  vi.stubEnv("CONNECTOR_TOKEN_ENCRYPTION_KEY", Buffer.from(TEST_KEY).toString("base64"));
  vi.stubEnv("TELEGRAM_BOT_TOKEN", BOT_TOKEN);
  vi.stubEnv("TELEGRAM_BOT_USERNAME", BOT_USERNAME);
  vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", WEBHOOK_SECRET);
  vi.stubGlobal("fetch", bot.fetch);
  logs = [];
  for (const method of ["info", "warn", "error"] as const) {
    vi.spyOn(console, method).mockImplementation((line: unknown) => {
      logs.push(String(line));
    });
  }
  signInAs(ALICE);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("POST /api/connectors/telegram/link", () => {
  it("returns a t.me link with a new code and stores only its hash for 10 minutes", async () => {
    const response = await link();
    const body = (await response.json()) as { deepLink: string; expiresAt: string };
    const url = new URL(body.deepLink);
    expect(url.origin + url.pathname).toBe(`https://t.me/${BOT_USERNAME}`);
    const code = url.searchParams.get("start")!;
    expect(code).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(links.rows.get(ALICE)!.codeHash).toBe(await hashLinkCode(code));
    expect(JSON.stringify([...links.rows.values()])).not.toContain(code);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("refuses when Telegram is not set up, an anonymous session and another origin, and stores nothing", async () => {
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", "");
    expect((await link()).status).toBe(503);
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", WEBHOOK_SECRET);
    vi.stubEnv("CONNECTOR_TOKEN_ENCRYPTION_KEY", "");
    expect((await link()).status).toBe(503);
    vi.stubEnv("CONNECTOR_TOKEN_ENCRYPTION_KEY", Buffer.from(TEST_KEY).toString("base64"));
    signInAs(ALICE, true);
    expect((await link()).status).toBe(403);
    signInAs(ALICE);
    expect((await linkRoute.POST(postJson("/api/connectors/telegram/link", {}, { origin: "https://evil.example" }))).status).toBe(403);
    expect(links.rows.size).toBe(0);
  });
});

describe("POST /api/connectors/telegram/confirm", () => {
  it("links the chat of the proof, sealed for this user, once", async () => {
    const proof = await proofFor();
    expect(outcome(await confirm(proof))).toBe("linked");
    const row = links.rows.get(ALICE)!;
    expect(row.codeHash).toBeNull();
    expect(row.chat).not.toContain(String(CHAT_ID));
    expect(await openChat(TEST_KEY, ALICE, row.chat!)).toEqual({ chatId: CHAT_ID, name: "Om" });
    expect(await openChat(TEST_KEY, BOB, row.chat!)).toBeNull();
    expect(outcome(await confirm(proof))).toBe("expired");
  });

  it("refuses a proof for another user's code, and leaves both users as they were", async () => {
    const aliceProof = await proofFor();
    signInAs(BOB);
    await link();
    expect(outcome(await confirm(aliceProof))).toBe("expired");
    expect(links.rows.get(BOB)!.chat).toBeNull();
    signInAs(ALICE);
    expect(outcome(await confirm(aliceProof))).toBe("linked");
  });

  it("refuses an expired proof, a changed proof, two proofs and no proof", async () => {
    const proof = await proofFor();
    const old = await sealLinkProof(TEST_KEY, { chatId: CHAT_ID, name: "x", codeHash: links.rows.get(ALICE)!.codeHash!, expiresAt: Date.now() - 1 });
    expect(outcome(await confirm(old))).toBe("expired");
    expect(outcome(await confirm(`${proof.slice(0, -2)}AA`))).toBe("error");
    expect(outcome(await confirm([proof, proof]))).toBe("error");
    expect(outcome(await confirmRoute.POST(postForm("/api/connectors/telegram/confirm")))).toBe("error");
    expect(links.rows.get(ALICE)!.chat).toBeNull();
  });

  it("keeps the old chat until a new link finishes", async () => {
    await linkChat(ALICE, CHAT_ID);
    const first = links.rows.get(ALICE)!.chat;
    await proofFor(CHAT_ID + 1);
    expect(links.rows.get(ALICE)!.chat).toBe(first);
  });
});

describe("POST /api/connectors/telegram/unlink", () => {
  it("deletes the user's row, also when Telegram is not set up", async () => {
    await linkChat();
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
    expect(outcome(await unlinkRoute.POST(postForm("/api/connectors/telegram/unlink")))).toBe("unlinked");
    expect(links.rows.has(ALICE)).toBe(false);
  });
});

describe("POST /api/connectors/telegram/send (the approval gate)", () => {
  it("sends the exact text, once, to the user's own linked chat", async () => {
    await linkChat();
    const key = crypto.randomUUID();
    const response = await send(`  ${TEXT}  `, key);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "sent" });
    expect(bot.sends).toEqual([expect.objectContaining({ chatId: CHAT_ID, text: TEXT })]);
    expect(bot.sends[0]!.body).not.toHaveProperty("parse_mode");
    expect((await send(TEXT, key)).status).toBe(409);
    expect(bot.sends).toHaveLength(1);
    expect(logs.join("\n")).not.toContain(TEXT);
    expect(logs.join("\n")).not.toContain(String(CHAT_ID));
    expect(logs.join("\n")).not.toContain(BOT_TOKEN);
  });

  it("sends nothing without a linked chat, and nothing to another user's chat", async () => {
    expect((await send(TEXT)).status).toBe(409);
    await linkChat(ALICE);
    signInAs(BOB);
    expect((await send(TEXT)).status).toBe(409);
    // A ciphertext copied from Alice's row does not open for Bob.
    links.rows.set(BOB, { ...links.rows.get(ALICE)!, lastKey: null });
    expect((await send(TEXT)).status).toBe(409);
    expect(bot.sends).toEqual([]);
  });

  it.each([
    ["no key", { text: TEXT }],
    ["a key that is not a UUID", { text: TEXT, key: "1" }],
    ["empty text", { text: "   ", key: crypto.randomUUID() }],
    ["text over 4,000 characters", { text: "x".repeat(4001), key: crypto.randomUUID() }],
    ["another field", { text: TEXT, key: crypto.randomUUID(), chatId: 1 }],
  ])("refuses %s before the quota, and sends nothing", async (_name, body) => {
    await linkChat();
    expect((await sendRoute.POST(postJson("/api/connectors/telegram/send", body))).status).toBe(400);
    expect(quotaCalls).toBe(0);
    expect(bot.sends).toEqual([]);
  });

  it("refuses an anonymous session, another origin, a missing setting and the quota, and sends nothing", async () => {
    await linkChat();
    signInAs(ALICE, true);
    expect((await send(TEXT)).status).toBe(403);
    signInAs(ALICE);
    expect((await sendRoute.POST(postJson("/api/connectors/telegram/send", { text: TEXT, key: crypto.randomUUID() }, { origin: "https://evil.example" }))).status).toBe(403);
    vi.stubEnv("TELEGRAM_BOT_USERNAME", "not a bot");
    expect((await send(TEXT)).status).toBe(503);
    vi.stubEnv("TELEGRAM_BOT_USERNAME", BOT_USERNAME);
    quotaAllowed = false;
    expect((await send(TEXT)).status).toBe(429);
    expect(links.rows.get(ALICE)!.lastKey).toBeNull();
    expect(bot.sends).toEqual([]);
  });

  it.each([
    [403, 409, "Start"],
    [400, 502, "refused"],
    [429, 429, "wait"],
  ] as const)("says Telegram answer %s did not send (HTTP %s)", async (answer, status, words) => {
    await linkChat();
    bot.answer(answer);
    const response = await send(TEXT);
    expect(response.status).toBe(status);
    expect(((await response.json()) as { error: { message: string } }).error.message).toContain(words);
  });

  it.each(["timeout", 500, "bad_json"] as const)("says the outcome is unknown after %s, and the same card cannot send again", async (answer) => {
    await linkChat();
    bot.answer(answer);
    const key = crypto.randomUUID();
    const response = await send(TEXT, key);
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: "unknown" });
    bot.answer(200);
    expect((await send(TEXT, key)).status).toBe(409);
    expect(bot.sends.length).toBeLessThanOrEqual(1);
  });

  it("never sends one card twice when the quota or the claim fails, is lost, or both", async () => {
    await sweepWriteFaults(async (faults) => {
      links = new FakeTelegramLinks();
      bot = fakeBot();
      vi.stubGlobal("fetch", bot.fetch);
      quota = new Quota();
      await linkChat();
      const repo = links.as(ALICE);
      faults.wrap(quota, ["consume"], { label: "quota" });
      faults.wrap(repo, ["claimSend"], { label: "claim" });
      vi.mocked(createTelegramLinkRepository).mockImplementation(() => repo);
      const key = crypto.randomUUID();
      const first = await send(TEXT, key);
      const failed = faults.fired.length > 0;
      expect(first.status).toBe(failed ? 503 : 200);
      faults.disarm();
      // The same card again (a double click or a retry): never a second message.
      const again = await send(TEXT, key);
      expect([200, 409]).toContain(again.status);
      // A lost claim stores the key, so the retry sends nothing and the user presses Send on a new card.
      expect(bot.sends.length).toBe(!failed || again.status === 200 ? 1 : 0);
      // A new card sends.
      expect((await send(TEXT)).status).toBe(200);
    });
  });
});
