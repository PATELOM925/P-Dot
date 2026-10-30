import "server-only";

/**
 * Fixes two habits of some models in streamed reply text: narrow and normal
 * non-breaking spaces, and full-width citation brackets (【1】 for [1]). Runs
 * on each chunk, so a bracket pair split across two chunks stays as it is.
 */
export function normalizeReplyText(text: string): string {
  return text.replace(/[  ]/g, " ").replace(/【(\d{1,3})】/g, "[$1]");
}
