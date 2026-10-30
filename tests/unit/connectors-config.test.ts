import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { QrCode } from "@/components/ui/QrCode";
import { PLANNED, connectorLayout } from "@/features/connectors/layout";
import { SendToTelegram } from "@/features/connectors/SendToTelegram";
import { TelegramCard } from "@/features/connectors/TelegramCard";
import { TELEGRAM_MAX_SEND_CHARS, TELEGRAM_OUTCOMES, telegramOutcomeMessage, telegramSendText } from "@/lib/telegram";
import { getTelegramConfig } from "@/server/config";
import { TEST_KEY } from "../support/fake-mcp";
import { BOT_TOKEN, BOT_USERNAME, WEBHOOK_SECRET } from "../support/fake-telegram";

/** Decision 0020: each new connector is off and stays under "Coming soon" until its settings exist. */
const KEY = Buffer.from(TEST_KEY).toString("base64");
const env = (values: Record<string, string>) => values as unknown as NodeJS.ProcessEnv;
const telegramEnv = { TELEGRAM_BOT_TOKEN: BOT_TOKEN, TELEGRAM_BOT_USERNAME: BOT_USERNAME, TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET, CONNECTOR_TOKEN_ENCRYPTION_KEY: KEY };

describe("connectorLayout", () => {
  it("with no new settings, shows the same cards as before", () => {
    const layout = connectorLayout({ isAppReady: () => false, telegramReady: false });
    expect(layout.apps).toEqual(["notion", "linear", "todoist"]);
    expect(layout.telegram).toBe(false);
    expect(layout.planned.map((item) => item.key)).toEqual(["telegram", "github", "vercel", "whatsapp", "phone"]);
  });

  it("moves GitHub and Telegram to Your accounts only when their settings exist", () => {
    const github = connectorLayout({ isAppReady: (app) => app === "github", telegramReady: false });
    expect(github.apps).toEqual(["notion", "linear", "todoist", "github"]);
    expect(github.planned.map((item) => item.key)).toEqual(["telegram", "vercel", "whatsapp", "phone"]);
    const telegram = connectorLayout({ isAppReady: () => false, telegramReady: true });
    expect(telegram.telegram).toBe(true);
    expect(telegram.planned.map((item) => item.key)).toEqual(["github", "vercel", "whatsapp", "phone"]);
  });

  it("keeps Vercel, WhatsApp and Phone calls as planned", () => {
    const all = connectorLayout({ isAppReady: () => true, telegramReady: true });
    expect(all.planned.map((item) => item.key)).toEqual(["vercel", "whatsapp", "phone"]);
    expect(PLANNED).toHaveLength(5);
  });
});

describe("getTelegramConfig", () => {
  it("is not set up, with no bad names, when the three Telegram values are missing", () => {
    expect(getTelegramConfig(env({ CONNECTOR_TOKEN_ENCRYPTION_KEY: KEY }))).toEqual({ status: "not_set_up", invalid: [] });
  });

  it("names each missing or bad value, never a value", () => {
    const state = getTelegramConfig(env({ ...telegramEnv, TELEGRAM_BOT_USERNAME: "PDotTest", TELEGRAM_WEBHOOK_SECRET: "short" }));
    expect(state).toEqual({ status: "not_set_up", invalid: ["TELEGRAM_BOT_USERNAME", "TELEGRAM_WEBHOOK_SECRET"] });
    expect(getTelegramConfig(env({ ...telegramEnv, CONNECTOR_TOKEN_ENCRYPTION_KEY: "" }))).toEqual({
      status: "not_set_up",
      invalid: ["CONNECTOR_TOKEN_ENCRYPTION_KEY"],
    });
    expect(getTelegramConfig(env({ ...telegramEnv, TELEGRAM_BOT_TOKEN: "not-a-token" }))).toMatchObject({ invalid: ["TELEGRAM_BOT_TOKEN"] });
    expect(JSON.stringify(getTelegramConfig(env({ ...telegramEnv, TELEGRAM_BOT_TOKEN: "x" })))).not.toContain(WEBHOOK_SECRET);
  });

  it("is ready with all four, and drops an @ before the bot name", () => {
    const state = getTelegramConfig(env({ ...telegramEnv, TELEGRAM_BOT_USERNAME: `@${BOT_USERNAME}` }));
    expect(state.status).toBe("ready");
    if (state.status === "ready") expect(state.config.botUsername).toBe(BOT_USERNAME);
  });
});

describe("Telegram words and limits", () => {
  it("has a message for every outcome and none for other values", () => {
    for (const outcome of TELEGRAM_OUTCOMES) expect(telegramOutcomeMessage(outcome)).not.toBeNull();
    expect(telegramOutcomeMessage("hacked")).toBeNull();
    expect(telegramOutcomeMessage(["linked"])).toBeNull();
  });

  it("cuts long text at the limit and never in the middle of an emoji", () => {
    expect(telegramSendText("  hi  ")).toEqual({ text: "hi", cut: false });
    const long = `${"x".repeat(TELEGRAM_MAX_SEND_CHARS - 1)}😀tail`;
    const cut = telegramSendText(long);
    expect(cut.cut).toBe(true);
    expect(cut.text).toBe("x".repeat(TELEGRAM_MAX_SEND_CHARS - 1));
  });
});

describe("cards", () => {
  it("renders a QR code as SVG shapes only", () => {
    const html = renderToStaticMarkup(createElement(QrCode, { text: "https://pdot.example/today", label: "QR code" }));
    expect(html).toMatch(/^<svg[^>]*class="qr-code"[^>]*role="img"[^>]*aria-label="QR code"/);
    expect(html).toContain("<path d=\"M");
    expect(html).not.toContain("<script");
  });

  it("shows Unlink for a linked chat and no chat ID", () => {
    const html = renderToStaticMarkup(
      createElement(TelegramCard, { state: { kind: "linked", name: "Om", linkedAt: "2026-10-30T10:00:00.000Z" }, message: null }),
    );
    expect(html).toContain("Linked to Om since Oct 30, 2026");
    expect(html).toContain('action="/api/connectors/telegram/unlink"');
  });

  it("starts the send card closed, so nothing can send without a press", () => {
    const html = renderToStaticMarkup(createElement(SendToTelegram, { text: "Brief", chatName: "Om" }));
    expect(html).toContain("Send to Telegram");
    expect(html).not.toContain("Needs your approval");
    expect(renderToStaticMarkup(createElement(SendToTelegram, { text: "   ", chatName: "Om" }))).toBe("");
  });
});
