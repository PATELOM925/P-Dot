import type { TelegramLinkRepository, TelegramLinkView } from "@/server/db/telegram-links";

/**
 * Fakes for decision 0020: the telegram_links rows with the same conditions
 * as the SQL functions, and the Bot API behind one `fetch`.
 */

export const BOT_TOKEN = `123456789:${"A".repeat(35)}`;
export const BOT_USERNAME = "PDotTestBot";
export const WEBHOOK_SECRET = `whsec_${"s".repeat(40)}`;

interface Row {
  chat: string | null;
  linkedAt: string | null;
  codeHash: string | null;
  expiresAt: number | null;
  lastKey: string | null;
}

/** One store for all users. `as(userId)` is the repository of one session, as RLS makes it. */
export class FakeTelegramLinks {
  rows = new Map<string, Row>();
  now = () => Date.now();

  as(userId: string): TelegramLinkRepository {
    const rows = this.rows;
    const now = () => this.now();
    return {
      async getLink(owner): Promise<TelegramLinkView | null> {
        const row = owner === userId ? rows.get(userId) : undefined;
        return row ? { chatCiphertext: row.chat, linkedAt: row.linkedAt } : null;
      },
      async startLink(codeHash) {
        const row = rows.get(userId) ?? { chat: null, linkedAt: null, codeHash: null, expiresAt: null, lastKey: null };
        row.codeHash = codeHash;
        row.expiresAt = now() + 10 * 60_000;
        rows.set(userId, row);
        return new Date(row.expiresAt).toISOString();
      },
      async confirmLink(codeHash, chat) {
        const row = rows.get(userId);
        if (!row || row.codeHash !== codeHash || (row.expiresAt ?? 0) <= now()) return false;
        Object.assign(row, { chat, linkedAt: new Date(now()).toISOString(), codeHash: null, expiresAt: null, lastKey: null });
        return true;
      },
      async claimSend(key) {
        const row = rows.get(userId);
        if (!row?.chat || row.lastKey === key) return null;
        row.lastKey = key;
        return row.chat;
      },
      async unlink(owner) {
        return owner === userId && rows.delete(userId);
      },
    };
  }
}

export interface BotSend {
  chatId: number;
  text: string;
  body: Record<string, unknown>;
}

/** The Bot API: records each sendMessage. `answer` sets the next answers. */
export function fakeBot() {
  const sends: BotSend[] = [];
  const calls: string[] = [];
  let next: number | "timeout" | "bad_json" = 200;
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    if (url !== `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage` || init?.method !== "POST") throw new Error(`No fake for ${url}`);
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    if (next === "timeout") {
      sends.push({ chatId: body.chat_id as number, text: body.text as string, body });
      throw new DOMException("The operation timed out.", "TimeoutError");
    }
    if (next === "bad_json") return new Response("<html>", { status: 200 });
    if (next !== 200) return Response.json({ ok: false, error_code: next, description: "no" }, { status: next });
    sends.push({ chatId: body.chat_id as number, text: body.text as string, body });
    return Response.json({ ok: true, result: { message_id: sends.length, chat: { id: body.chat_id } } });
  };
  return {
    fetch,
    sends,
    calls,
    answer(value: number | "timeout" | "bad_json") {
      next = value;
    },
  };
}

export type FakeBot = ReturnType<typeof fakeBot>;
