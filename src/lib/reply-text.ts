/**
 * Citation forms that some models write instead of [n]: 【1】, 【2†L1-L4】 and
 * [3†source]. A numbered form becomes [n], which the reply shows as a source
 * chip. A form with a name in place of the number, such as 【calendar†L1-L2】
 * or [calendar†L3], points to no source, so it is removed with the space before it.
 */
const CITATION_FORMS = /([ \t]?)(?:【([^】†\n]{0,40})†[^】\n]{0,60}】|【(\d{1,3})】|\[([^\]†\n]{1,40})†[^\]\n]{0,60}\])/g;

/** The start of a citation that the next chunk can complete. */
const OPEN_CITATION = /[ \t]?(?:【[^】\n]{0,100}|\[[A-Za-z0-9_.: -]{0,40}(?:†[^\]\n]{0,60})?)$/;

/** Replaces narrow and normal non-breaking spaces, and writes every citation form as [n] or removes it. */
export function normalizeReplyText(text: string): string {
  return text
    .replace(/[\u00A0\u202F]/g, " ")
    .replace(CITATION_FORMS, (_match, space: string, wide?: string, bare?: string, plain?: string) => {
      const label = (wide ?? bare ?? plain ?? "").trim();
      return /^\d{1,3}$/.test(label) ? `${space}[${label}]` : "";
    });
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
