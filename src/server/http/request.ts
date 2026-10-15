import "server-only";
import type { ApiErrorCode } from "@/types/api";

export type BodyResult =
  | { ok: true; value: unknown }
  | { ok: false; status: number; code: ApiErrorCode; message: string };

/**
 * Reads a JSON body without buffering more than `maxBytes`. Rejects non-JSON
 * content types so cross-site HTML forms cannot reach the API.
 */
export async function readJsonBody(request: Request, maxBytes: number): Promise<BodyResult> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^application\/json(\s*;|$)/i.test(contentType)) {
    return {
      ok: false,
      status: 415,
      code: "unsupported_media_type",
      message: "Send the request body as application/json.",
    };
  }

  const tooLarge = {
    ok: false,
    status: 413,
    code: "payload_too_large",
    message: "Request body is too large.",
  } as const;

  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return tooLarge;
  if (!request.body) return { ok: false, status: 400, code: "invalid_request", message: "Request body is required." };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return tooLarge;
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return { ok: true, value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) };
  } catch {
    return { ok: false, status: 400, code: "invalid_request", message: "Request body is not valid JSON." };
  }
}

/**
 * Defense in depth against cross-site requests that carry the session cookie:
 * when the browser sends an Origin header it must match this host.
 */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true; // Non-browser clients; the session cookie is still required.
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
