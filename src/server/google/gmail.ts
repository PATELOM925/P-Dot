import "server-only";
import { z } from "zod";
import { authorizedRequest, bounded, clip, requireScope } from "./api";
import { fromBase64Url, toBase64Url } from "./crypto";
import { READ_TIMEOUT_MS, WRITE_TIMEOUT_MS } from "./http";
import { GMAIL_READ_SCOPE, GMAIL_SEND_SCOPE } from "./oauth";
import type { GoogleAccess } from "./token-store";

// Gmail through plain fetch (decision 0014). Reads return bounded plain text
// only. Every answer is checked with zod. Nothing here logs mail content.

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

export const GMAIL_SEARCH_MAX_RESULTS = 10;
export const GMAIL_QUERY_MAX_CHARS = 500;
export const GMAIL_READ_MAX_CHARS = 8_000;
const MESSAGE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface GmailSummary {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  snippet: string;
}

export interface GmailMessage extends GmailSummary {
  cc: string;
  /** Plain text: the text/plain part, or the text/html part without tags. */
  text: string;
  /** True when the text was cut to GMAIL_READ_MAX_CHARS. */
  truncated: boolean;
}

const header = z.object({ name: z.string(), value: z.string() });
interface Part {
  mimeType?: string;
  body?: { data?: string; size?: number };
  headers?: z.infer<typeof header>[];
  parts?: Part[];
}
const part: z.ZodType<Part> = z.lazy(() =>
  z.object({
    mimeType: z.string().optional(),
    body: z.object({ data: z.string().optional(), size: z.number().optional() }).optional(),
    headers: z.array(header).optional(),
    parts: z.array(part).max(100).optional(),
  }),
);
const messageSchema = z.object({
  id: z.string().regex(MESSAGE_ID),
  threadId: z.string().max(64),
  snippet: z.string().optional(),
  payload: part.optional(),
});
const listSchema = z.object({ messages: z.array(z.object({ id: z.string().regex(MESSAGE_ID) })).optional() });
const sentSchema = z.object({ id: z.string().regex(MESSAGE_ID) });

function headerValue(message: z.infer<typeof messageSchema>, name: string, max: number): string {
  const found = message.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase());
  return clip(found?.value, max);
}

function summary(message: z.infer<typeof messageSchema>): GmailSummary {
  return {
    id: message.id,
    threadId: message.threadId,
    from: headerValue(message, "From", 320),
    to: headerValue(message, "To", 1000),
    subject: headerValue(message, "Subject", 300),
    date: headerValue(message, "Date", 100),
    snippet: clip(decodeEntities(message.snippet ?? ""), 500),
  };
}

export async function gmailSearch(
  access: GoogleAccess,
  query: string,
  maxResults = GMAIL_SEARCH_MAX_RESULTS,
  signal?: AbortSignal,
): Promise<GmailSummary[]> {
  requireScope(access, GMAIL_READ_SCOPE);
  const q = query.trim();
  if (q.length === 0 || q.length > GMAIL_QUERY_MAX_CHARS) throw new RangeError("query length");
  const max = Math.max(1, Math.min(GMAIL_SEARCH_MAX_RESULTS, Math.trunc(maxResults)));
  const list = await authorizedRequest(
    access,
    `${BASE}/messages?${new URLSearchParams({ q, maxResults: String(max) })}`,
    { method: "GET" },
    READ_TIMEOUT_MS,
    listSchema,
    signal,
  );
  const ids = (list.messages ?? []).slice(0, max).map((m) => m.id);
  const metadata = new URLSearchParams({ format: "metadata" });
  for (const name of ["From", "To", "Subject", "Date"]) metadata.append("metadataHeaders", name);
  const messages = await Promise.all(
    ids.map((id) =>
      authorizedRequest(access, `${BASE}/messages/${id}?${metadata}`, { method: "GET" }, READ_TIMEOUT_MS, messageSchema, signal),
    ),
  );
  return messages.map(summary);
}

function findPart(root: Part | undefined, mimeType: string): Part | null {
  if (!root) return null;
  if (root.mimeType === mimeType && root.body?.data) return root;
  for (const child of root.parts ?? []) {
    const found = findPart(child, mimeType);
    if (found) return found;
  }
  return null;
}

function decodeBody(data: string): string {
  const bytes = fromBase64Url(data.replace(/=+$/, ""));
  return bytes ? new TextDecoder("utf-8").decode(bytes) : "";
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d{1,7});/g, (_m, n: string) => safeChar(Number(n)))
    .replace(/&#x([0-9a-f]{1,6});/gi, (_m, n: string) => safeChar(parseInt(n, 16)))
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function safeChar(code: number): string {
  return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
}

/** Plain text from HTML: no script or style, tags removed, entities decoded. Nothing is rendered. */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|head)[\s\S]*?<\/\1\s*>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|tr|h[1-6])\s*>/gi, "\n")
      .replace(/<[^>]*>/g, " "),
  )
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function gmailRead(access: GoogleAccess, messageId: string, signal?: AbortSignal): Promise<GmailMessage> {
  requireScope(access, GMAIL_READ_SCOPE);
  if (!MESSAGE_ID.test(messageId)) throw new RangeError("message id");
  const message = await authorizedRequest(
    access,
    `${BASE}/messages/${messageId}?format=full`,
    { method: "GET" },
    READ_TIMEOUT_MS,
    messageSchema,
    signal,
  );
  const plain = findPart(message.payload, "text/plain");
  const html = plain ? null : findPart(message.payload, "text/html");
  const raw = plain ? decodeBody(plain.body!.data!) : html ? htmlToText(decodeBody(html.body!.data!)) : "";
  const body = bounded(raw.replace(/\r\n/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ""), GMAIL_READ_MAX_CHARS);
  return { ...summary(message), cc: headerValue(message, "Cc", 1000), text: body.text, truncated: body.cut };
}

// ---------------------------------------------------------------------------
// Sending. Only an approved send_email payload reaches here (decision 0014).
// ---------------------------------------------------------------------------

/** The same address form as the database check: ASCII only, so no space, CR or LF. */
const EMAIL =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

export interface EmailToSend {
  to: string[];
  subject: string;
  body: string;
}

function encodeHeader(value: string): string {
  // RFC 2047: a non-ASCII subject goes as UTF-8 base64 words.
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  const bytes = new TextEncoder().encode(value);
  const words: string[] = [];
  for (let i = 0; i < bytes.length; ) {
    let end = Math.min(bytes.length, i + 45);
    while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end -= 1;
    words.push(`=?UTF-8?B?${btoa(String.fromCharCode(...bytes.slice(i, end)))}?=`);
    i = end;
  }
  return words.join("\r\n ");
}

function base64Lines(text: string): string {
  const bytes = new TextEncoder().encode(text.replace(/\r?\n/g, "\r\n"));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return (btoa(binary).match(/.{1,76}/g) ?? [""]).join("\r\n");
}

/**
 * The RFC 2822 message. Headers come only from the checked payload; the body
 * is base64. The To header folds after each comma, so every physical line
 * stays far below the 998-character limit (one address is at most 254).
 */
export function buildEmail(message: EmailToSend): string {
  if (message.to.length < 1 || message.to.length > 10 || !message.to.every((address) => address.length <= 254 && EMAIL.test(address))) {
    throw new RangeError("recipients");
  }
  if (/[\u0000-\u001f\u007f]/.test(message.subject) || message.subject.length === 0) throw new RangeError("subject");
  return [
    `To: ${message.to.join(",\r\n ")}`,
    `Subject: ${encodeHeader(message.subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(message.body),
  ].join("\r\n");
}

/** Sends one email. Returns Gmail's message ID. Never retried: Gmail has no idempotency key. */
export async function gmailSend(access: GoogleAccess, message: EmailToSend): Promise<{ messageId: string }> {
  requireScope(access, GMAIL_SEND_SCOPE);
  const raw = toBase64Url(new TextEncoder().encode(buildEmail(message)));
  const sent = await authorizedRequest(
    access,
    `${BASE}/messages/send`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ raw }) },
    WRITE_TIMEOUT_MS,
    sentSchema,
  );
  return { messageId: sent.id };
}
