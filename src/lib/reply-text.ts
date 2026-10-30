/**
 * Citation forms that some models write instead of [n]: 【1】, 【2†L1-L4】 and
 * [3†source]. Each becomes [n], which the reply shows as a source chip.
 */
const CITATION_FORMS = /【(\d{1,3})(?:†[^】\n]{0,60})?】|\[(\d{1,3})†[^\]\n]{0,60}\]/g;

/** The start of a citation that the next chunk can complete. */
const OPEN_CITATION = /(?:【\d{0,3}(?:†[^】\n]{0,60})?|\[\d{1,3}(?:†[^\]\n]{0,60})?)$/;

/** Replaces narrow and normal non-breaking spaces, and writes every citation form as [n]. */
export function normalizeReplyText(text: string): string {
  return text
    .replace(/[  ]/g, " ")
    .replace(CITATION_FORMS, (_match, wide: string | undefined, plain: string | undefined) => `[${wide ?? plain}]`);
}

/**
 * Normalizes streamed text. A citation split across two chunks is held back
 * until it closes, so the user never sees a raw token. `flush` gives back what
 * is still held when the stream ends.
 */
export function createReplyNormalizer(): { push(chunk: string): string; flush(): string } {
  let held = "";
  return {
    push(chunk) {
      const text = held + chunk;
      const open = OPEN_CITATION.exec(text);
      held = open ? open[0] : "";
      return normalizeReplyText(open ? text.slice(0, open.index) : text);
    },
    flush() {
      const rest = normalizeReplyText(held);
      held = "";
      return rest;
    },
  };
}
