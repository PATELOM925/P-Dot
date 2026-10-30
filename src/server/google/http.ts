import "server-only";
import type { z } from "zod";

// Plain fetch to Google with a timeout, a size limit and a zod check of every
// answer (decision 0014). Error bodies are read only for their error label and
// are never logged.

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type GoogleErrorKind =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "rejected"
  | "unavailable"
  | "timeout"
  | "network"
  | "bad_response";

export class GoogleApiError extends Error {
  override readonly name = "GoogleApiError";

  constructor(
    readonly kind: GoogleErrorKind,
    /** The HTTP status, or null when no answer came. */
    readonly status: number | null,
    /** A short label from the error body, for example "invalid_grant". Never free text. */
    readonly label: string | null = null,
  ) {
    super(`Google request failed: ${kind}`);
  }

  /** True only when Google answered 4xx, so a write did not happen. Anything else may have acted. */
  get notDone(): boolean {
    return this.status !== null && this.status >= 400 && this.status < 500;
  }
}

export const READ_TIMEOUT_MS = 10_000;
export const WRITE_TIMEOUT_MS = 15_000;
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

const LABEL = /^[A-Za-z_]{1,64}$/;

function kindFor(status: number): GoogleErrorKind {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 408 || status === 429 || status >= 500) return "unavailable";
  return "rejected";
}

async function readBounded(response: Response, maxBytes: number): Promise<string | null> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/** The error label: `error` (OAuth) or `error.errors[0].reason` / `error.status` (APIs). Only a short identifier. */
function errorLabel(text: string | null): string | null {
  if (!text) return null;
  try {
    const body = JSON.parse(text) as { error?: unknown };
    const error = body.error;
    const candidates =
      typeof error === "string"
        ? [error]
        : error && typeof error === "object"
          ? [
              (error as { errors?: { reason?: unknown }[] }).errors?.[0]?.reason,
              (error as { status?: unknown }).status,
            ]
          : [];
    const label = candidates.find((value): value is string => typeof value === "string" && LABEL.test(value));
    return label ?? null;
  } catch {
    return null;
  }
}

/** Sends one request and returns the parsed body. An empty 2xx body parses as {}. */
export async function googleRequest<T>(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  schema: z.ZodType<T>,
): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    throw new GoogleApiError(name === "TimeoutError" || name === "AbortError" ? "timeout" : "network", null);
  }
  let text: string | null;
  try {
    text = await readBounded(response, MAX_RESPONSE_BYTES);
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (!response.ok) throw new GoogleApiError(kindFor(response.status), response.status);
    throw new GoogleApiError(name === "TimeoutError" || name === "AbortError" ? "timeout" : "bad_response", null);
  }
  if (!response.ok) throw new GoogleApiError(kindFor(response.status), response.status, errorLabel(text));
  if (text === null) throw new GoogleApiError("bad_response", null);
  let json: unknown;
  try {
    json = text === "" ? {} : JSON.parse(text);
  } catch {
    throw new GoogleApiError("bad_response", null);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new GoogleApiError("bad_response", null);
  return parsed.data;
}
