import { MAX_MESSAGE_CHARS } from "@/lib/limits";

export interface ComposerLimit {
  /** Show the "n / limit" counter. */
  showCount: boolean;
  over: boolean;
  /** Shown under the box while the text is over the limit. */
  message: string | null;
}

/**
 * The box keeps a long paste in full, so nothing is cut without a word. Send
 * stays blocked until the text is short enough.
 */
export function composerLimit(length: number, max = MAX_MESSAGE_CHARS): ComposerLimit {
  const over = length > max;
  return {
    showCount: length >= Math.floor(max * 0.9),
    over,
    message: over
      ? `Your message has ${length.toLocaleString("en-US")} characters. The limit is ${max.toLocaleString("en-US")}. Remove ${(length - max).toLocaleString("en-US")} characters to send it, or add the long text as a document on the Memory page.`
      : null,
  };
}
