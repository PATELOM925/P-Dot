import "server-only";
import type { z } from "zod";
import { googleRequest } from "./http";
import type { DataScope } from "./oauth";
import type { GoogleAccess } from "./token-store";

/** The connection lacks a scope that the call needs. Google was not called. */
export class GoogleScopeMissingError extends Error {
  override readonly name = "GoogleScopeMissingError";
  constructor() {
    super("The Google connection does not allow this.");
  }
}

export function requireScope(access: GoogleAccess, ...anyOf: DataScope[]): void {
  if (!anyOf.some((scope) => access.scopes.includes(scope))) throw new GoogleScopeMissingError();
}

/** One call with the user's access token. The token is never logged. */
export async function authorizedRequest<T>(
  access: GoogleAccess,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  schema: z.ZodType<T>,
): Promise<T> {
  const token = await access.accessToken();
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  return googleRequest(access.fetch, url, { ...init, headers }, timeoutMs, schema);
}

/** Cuts text to `max` characters. `cut` is true when it was longer. */
export function bounded(text: string, max: number): { text: string; cut: boolean } {
  const chars = Array.from(text);
  return chars.length <= max ? { text, cut: false } : { text: chars.slice(0, max).join(""), cut: true };
}

export const clip = (text: string | undefined | null, max: number) => bounded((text ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ""), max).text;

const UNTRUSTED_TAG = "untrusted_google_data";

/**
 * Wraps text read from Gmail or Calendar for a model prompt. Anyone can send
 * the user an email, so this text is data, never instructions, and it can
 * never approve or authorize anything (decision 0014). A closing tag inside
 * the text is broken so it cannot end the block early.
 */
export function untrustedGoogleBlock(source: "gmail" | "calendar", text: string): string {
  const safe = text.replace(new RegExp(`<\\s*/?\\s*${UNTRUSTED_TAG}`, "gi"), "[tag removed]");
  return `<${UNTRUSTED_TAG} source="${source}">\n${safe}\n</${UNTRUSTED_TAG}>`;
}
