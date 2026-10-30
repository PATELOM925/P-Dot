import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/telegram/webhook/route";
import { openText } from "@/server/google/crypto";
import { hashLinkCode, openLinkProof } from "@/server/telegram/seal";
import { HELP_TEXT, START_WITHOUT_CODE_TEXT, secretMatches } from "@/server/telegram/webhook";
import { TEST_KEY } from "../support/fake-mcp";
import { BOT_TOKEN, BOT_USERNAME, WEBHOOK_SECRET } from "../support/fake-telegram";

/** Decision 0020: the webhook checks its secret, reads nothing, calls nothing and replies only to the sender. */
const SITE = "https://pdot.example";
const CODE = "Abc_def-123456789012345678901234";
const CHAT_ID = 424242;
const SECRET_TEXT = "my private note about the merger";

let logs: string[];
let outbound: string[];

beforeEach(() => {
  vi.stubEnv("SITE_URL", SITE);
  vi.stubEnv("CONNECTOR_TOKEN_ENCRYPTION_KEY", Buffer.from(TEST_KEY).toString("base64"));
  vi.stubEnv("TELEGRAM_BOT_TOKEN", BOT_TOKEN);
  vi.stubEnv("TELEGRAM_BOT_USERNAME", BOT_USERNAME);
  vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", WEBHOOK_SECRET);
  outbound = [];
  vi.stubGlobal("fetch", async (input: string) => {
    outbound.push(String(input));
    throw new Error("the webhook must not call out");
  });
  logs = [];
  for (const method of ["info", "warn", "error"] as const) {
    vi.spyOn(console, method).mockImplementation((line: unknown) => {
      logs.push(String(line));
    });
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const message = (text: string | undefined, extra: { chatType?: string; isBot?: boolean; chatId?: number; firstName?: string } = {}) => ({
  update_id: 1,
  message: {
    message_id: 7,
    date: 1,
    chat: { id: extra.chatId ?? CHAT_ID, type: extra.chatType ?? "private" },
    from: { id: extra.chatId ?? CHAT_ID, is_bot: extra.isBot ?? false, first_name: extra.firstName ?? "Om" },
    ...(text === undefined ? {} : { text }),
  },
});

function hook(body: unknown, secret: string | null = WEBHOOK_SECRET, raw?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (secret !== null) headers["x-telegram-bot-api-secret-token"] = secret;
  return POST(new Request(`${SITE}/api/telegram/webhook`, { method: "POST", headers, body: raw ?? JSON.stringify(body) }));
}

const replyOf = async (response: Response) => (await response.json()) as Record<string, unknown> & { reply_markup?: { inline_keyboard: { url: string }[][] } };

describe("POST /api/telegram/webhook", () => {
  it("is not there when Telegram is not set up", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "");
    vi.stubEnv("TELEGRAM_BOT_USERNAME", "");
    vi.stubEnv("TELEGRAM_WEBHOOK_SECRET", "");
    const response = await hook(message("/start"));
    expect(response.status).toBe(404);
  });

  it.each([
    ["no secret header", null],
    ["a wrong secret", `${WEBHOOK_SECRET.slice(0, -1)}x`],
    ["a secret with one more character", `${WEBHOOK_SECRET}x`],
    ["a part of the secret", WEBHOOK_SECRET.slice(0, 10)],
    ["an empty secret", ""],
  ])("refuses %s with 401 and no body", async (_name, secret) => {
    const response = await hook(message(`/start ${CODE}`), secret);
    expect(response.status).toBe(401);
    expect(await response.text()).toBe("");
  });

  it("answers /start <code> with a button to a sealed proof that holds the hash of the code, not the code", async () => {
    const response = await hook(message(`/start ${CODE}`, { firstName: "Om‮\n Patel" }));
    expect(response.status).toBe(200);
    const reply = await replyOf(response);
    expect(reply).toMatchObject({ method: "sendMessage", chat_id: CHAT_ID });
    const url = new URL(reply.reply_markup!.inline_keyboard[0]![0]!.url);
    expect(url.origin + url.pathname).toBe(`${SITE}/connectors/telegram/confirm`);
    expect(JSON.stringify(reply)).not.toContain(CODE);
    const sealed = url.searchParams.get("t")!;
    expect(await openText(TEST_KEY, sealed, "pdot:telegram_link_proof")).not.toContain(CODE);
    const proof = await openLinkProof(TEST_KEY, sealed, Date.now());
    expect(proof).toMatchObject({ chatId: CHAT_ID, name: "Om Patel", codeHash: await hashLinkCode(CODE) });
    expect(outbound).toEqual([]);
  });

  it("accepts the bot's own name after /start", async () => {
    const reply = await replyOf(await hook(message(`/start@${BOT_USERNAME} ${CODE}`)));
    expect(reply.reply_markup?.inline_keyboard[0]![0]!.url).toContain("/connectors/telegram/confirm?t=");
  });

  it.each([["/start"], ["/start short"], [`/start ${CODE}!`], [`/start ${CODE} extra`]])("answers %s without a link", async (text) => {
    const reply = await replyOf(await hook(message(text)));
    expect(reply.text === START_WITHOUT_CODE_TEXT || reply.text === HELP_TEXT).toBe(true);
    expect(JSON.stringify(reply)).not.toContain("/connectors/telegram/confirm");
  });

  it("answers any other message with a fixed text that does not repeat it", async () => {
    const reply = await replyOf(await hook(message(SECRET_TEXT)));
    expect(reply).toMatchObject({ method: "sendMessage", chat_id: CHAT_ID, text: HELP_TEXT });
    expect(JSON.stringify(reply)).not.toContain(SECRET_TEXT);
    expect(logs.join("\n")).not.toContain(SECRET_TEXT);
    expect(logs.join("\n")).not.toContain(String(CHAT_ID));
  });

  it.each([
    ["a group chat", message(`/start ${CODE}`, { chatType: "group", chatId: -100 })],
    ["a message from a bot", message(`/start ${CODE}`, { isBot: true })],
    ["an update with no message", { update_id: 2, edited_message: { text: "x" } }],
    ["an update that does not parse", { nothing: true }],
  ])("ignores %s with an empty 200", async (_name, body) => {
    const response = await hook(body);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });

  it("answers an empty 200 to a body that is too large or not JSON, so Telegram does not send it again", async () => {
    expect((await hook(null, WEBHOOK_SECRET, "{")).status).toBe(200);
    const big = await hook(null, WEBHOOK_SECRET, JSON.stringify(message("x".repeat(70_000))));
    expect(big.status).toBe(200);
    expect(await big.text()).toBe("");
  });

  it("never logs a code, a chat ID or message text", async () => {
    await hook(message(`/start ${CODE}`));
    await hook(message(SECRET_TEXT));
    const text = logs.join("\n");
    expect(text).not.toContain(CODE);
    expect(text).not.toContain(SECRET_TEXT);
    expect(text).not.toContain(String(CHAT_ID));
    expect(text).not.toContain(WEBHOOK_SECRET);
  });
});

describe("secretMatches", () => {
  it("accepts only the exact secret", () => {
    expect(secretMatches(WEBHOOK_SECRET, WEBHOOK_SECRET)).toBe(true);
    expect(secretMatches(null, WEBHOOK_SECRET)).toBe(false);
    expect(secretMatches(WEBHOOK_SECRET.toUpperCase(), WEBHOOK_SECRET)).toBe(false);
    expect(secretMatches("x".repeat(300), "x".repeat(300))).toBe(false);
  });
});
