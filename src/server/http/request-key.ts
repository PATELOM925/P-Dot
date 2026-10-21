import "server-only";
import { z } from "zod";
import { REQUEST_KEY_HEADER } from "@/lib/request-key";

/** A request key and the fingerprint of the request it was sent with (decision 0012). */
export interface ClientRequest {
  id: string;
  hash: string;
}

const keySchema = z.uuid();

/** The request key from the header: null when there is none, "invalid" when it is not a UUID. */
export function readRequestKey(request: Request): string | null | "invalid" {
  const value = request.headers.get(REQUEST_KEY_HEADER);
  if (value === null) return null;
  const parsed = keySchema.safeParse(value.trim());
  return parsed.success ? parsed.data.toLowerCase() : "invalid";
}

/** SHA-256 in lower-case hex of the JSON array of validated request values. */
export async function requestFingerprint(parts: readonly string[]): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(parts)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function clientRequest(key: string | null, parts: readonly string[]): Promise<ClientRequest | null> {
  return key ? { id: key, hash: await requestFingerprint(parts) } : null;
}
