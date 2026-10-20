/** Longest URL kept, before and after normalization. A normalized URL is ASCII, so this is also its byte count. */
export const MAX_SAFE_URL_CHARS = 2048;

/**
 * Returns a normalized http(s) URL, or null for anything else (javascript:,
 * data:, credentials in the URL, malformed input, a normalized URL longer
 * than MAX_SAFE_URL_CHARS). Used for source links.
 */
export function toSafeHttpUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_SAFE_URL_CHARS) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  const normalized = url.toString();
  return normalized.length > MAX_SAFE_URL_CHARS ? null : normalized;
}

/**
 * Accepts only same-origin relative paths for post-login redirects, so a
 * crafted `next` parameter cannot send users to another site.
 */
export function safeNextPath(value: unknown, fallback = "/chat"): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) {
    return fallback;
  }
  if (value.includes("\\") || /[\u0000-\u001f]/.test(value)) return fallback;
  try {
    const base = "http://p-dot.invalid";
    const url = new URL(value, base);
    if (url.origin !== base) return fallback;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return fallback;
  }
}
