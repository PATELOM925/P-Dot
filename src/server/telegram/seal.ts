import "server-only";
import { z } from "zod";
import { openText, randomToken, sealText } from "@/server/google/crypto";

// Sealed values of the Telegram link (decision 0020). The proof goes from the
// webhook to the confirm page in a URL. The stored chat is bound to one user,
// so a value copied to another row does not open, and a user cannot write a
// chat that the Worker did not seal.

const PROOF_ASSOCIATED_DATA = "pdot:telegram_link_proof";
export const chatAssociatedData = (userId: string) => `pdot:telegram_links:${userId}`;

export const LINK_TTL_MS = 10 * 60_000;
export const MAX_PROOF_CHARS = 1024;
export const MAX_NAME_CHARS = 64;

const HASH = /^[0-9a-f]{64}$/;
const chatId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const name = z.string().max(MAX_NAME_CHARS);

export interface TelegramChat {
  chatId: number;
  /** The Telegram first name, cleaned, at most 64 characters. Shown to the user only. */
  name: string;
}

export interface LinkProof extends TelegramChat {
  /** SHA-256 of the one-time code, never the code. */
  codeHash: string;
  expiresAt: number;
}

const proofSchema = z.object({ c: chatId, n: name, h: z.string().regex(HASH), e: z.number().int() }).strict();
const chatSchema = z.object({ c: chatId, n: name }).strict();

/** Control characters and line breaks removed, white space joined, cut to 64 characters. */
export function cleanName(value: string | undefined): string {
  const clean = (value ?? "").replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/gu, " ").trim();
  return Array.from(clean).slice(0, MAX_NAME_CHARS).join("");
}

/** A new one-time code (32 base64url characters, allowed in a t.me start link) and its SHA-256. */
export async function newLinkCode(): Promise<{ code: string; hash: string }> {
  const code = randomToken(24);
  return { code, hash: await hashLinkCode(code) };
}

export async function hashLinkCode(code: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sealLinkProof(key: Uint8Array, proof: LinkProof): Promise<string> {
  const sealed = await sealText(
    key,
    JSON.stringify(proofSchema.parse({ c: proof.chatId, n: proof.name, h: proof.codeHash, e: proof.expiresAt })),
    PROOF_ASSOCIATED_DATA,
  );
  if (sealed.length > MAX_PROOF_CHARS) throw new Error("proof_too_large");
  return sealed;
}

/** The proof, "expired", or null when it does not open or parse. */
export async function openLinkProof(key: Uint8Array, sealed: string, now: number): Promise<LinkProof | "expired" | null> {
  if (sealed.length > MAX_PROOF_CHARS) return null;
  const text = await openText(key, sealed, PROOF_ASSOCIATED_DATA);
  if (text === null) return null;
  try {
    const parsed = proofSchema.safeParse(JSON.parse(text));
    if (!parsed.success) return null;
    const { c, n, h, e } = parsed.data;
    return e > now ? { chatId: c, name: n, codeHash: h, expiresAt: e } : "expired";
  } catch {
    return null;
  }
}

export function sealChat(key: Uint8Array, userId: string, chat: TelegramChat): Promise<string> {
  return sealText(key, JSON.stringify(chatSchema.parse({ c: chat.chatId, n: chat.name })), chatAssociatedData(userId));
}

/** The chat, or null when the value does not open for this user. */
export async function openChat(key: Uint8Array, userId: string, sealed: string): Promise<TelegramChat | null> {
  if (sealed.length > MAX_PROOF_CHARS) return null;
  const text = await openText(key, sealed, chatAssociatedData(userId));
  if (text === null) return null;
  try {
    const parsed = chatSchema.safeParse(JSON.parse(text));
    return parsed.success ? { chatId: parsed.data.c, name: parsed.data.n } : null;
  } catch {
    return null;
  }
}
