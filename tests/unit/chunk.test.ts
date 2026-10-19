import { describe, expect, it } from "vitest";
import { DOCUMENT_CHUNK_CHARS, MAX_DOCUMENT_CHARS, MAX_DOCUMENT_CHUNKS } from "@/lib/limits";
import { chunkText } from "@/server/assistant/chunk";

/** Numbered words with no punctuation, so each word is unique. */
function numberedWords(count: number): string {
  return Array.from({ length: count }, (_, i) => `w${String(i).padStart(4, "0")}`).join(" ");
}

describe("chunkText", () => {
  it("keeps every chunk within the size limit (default and custom)", () => {
    const text = numberedWords(3_000);
    for (const chunk of chunkText(text)) expect(chunk.length).toBeLessThanOrEqual(DOCUMENT_CHUNK_CHARS);
    for (const chunk of chunkText(text, { size: 50, overlap: 10, maxChunks: 1_000 })) {
      expect(chunk.length).toBeLessThanOrEqual(50);
    }
  });

  it("shares about the overlap length between consecutive chunks", () => {
    const chunks = chunkText(numberedWords(400), { size: 100, overlap: 20 });
    expect(chunks.length).toBeGreaterThan(3);
    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1]!;
      const next = chunks[i]!;
      const firstWord = next.split(" ")[0]!;
      const shared = prev.length - prev.indexOf(firstWord);
      expect(shared).toBeGreaterThanOrEqual(15);
      expect(shared).toBeLessThanOrEqual(40);
    }
  });

  it("prefers a blank line over a hard cut", () => {
    const a = "A".repeat(900);
    const b = "B".repeat(900);
    const c = "C".repeat(900);
    expect(chunkText(`${a}\n\n${b}\n\n${c}`, { size: 1_000, overlap: 0 })).toEqual([a, b, c]);
  });

  it("prefers a sentence end over a space", () => {
    const text = "Short sentence here. ".repeat(50);
    const chunks = chunkText(text, { size: 100, overlap: 0 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks.slice(0, -1)) expect(chunk.endsWith(".")).toBe(true);
  });

  it("never returns an empty or untrimmed chunk", () => {
    const chunks = chunkText("a\n\n\n\n   \n\n   b   \n\n  \n", { size: 3, overlap: 1 });
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(chunk.length).toBeGreaterThan(0);
      expect(chunk).toBe(chunk.trim());
    }
  });

  it("returns no chunks for whitespace only", () => {
    expect(chunkText("  \n\n  \t ")).toEqual([]);
  });

  it("returns one chunk for a short text", () => {
    expect(chunkText("Hello there.")).toEqual(["Hello there."]);
  });

  it("throws when more chunks than the maximum would be needed", () => {
    // "aaaa bbbb cccc" needs three chunks at size 5 with no overlap.
    expect(() => chunkText("aaaa bbbb cccc", { size: 5, overlap: 0, maxChunks: 2 })).toThrow(/more than 2 chunks/);
    expect(chunkText("aaaa bbbb cccc", { size: 5, overlap: 0, maxChunks: 3 })).toEqual(["aaaa", "bbbb", "cccc"]);
  });

  it("allows the largest document the app accepts", () => {
    const text = "word ".repeat(MAX_DOCUMENT_CHARS / 5);
    expect(text.length).toBe(MAX_DOCUMENT_CHARS);
    expect(chunkText(text).length).toBeLessThanOrEqual(MAX_DOCUMENT_CHUNKS);
  });

  it("cuts a long text with no spaces hard, at the size limit", () => {
    expect(chunkText("x".repeat(25), { size: 10, overlap: 0 })).toEqual(["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
  });

  it("never splits an emoji, so every chunk is valid text", () => {
    const text = "\u{1F600}".repeat(7);
    const chunks = chunkText(text, { size: 5, overlap: 0 });
    expect(chunks.join("")).toBe(text);
    for (const chunk of chunks) expect(chunk).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });

  it("splits text with no spaces at the size limit", () => {
    const text = "汉".repeat(30);
    expect(chunkText(text, { size: 10, overlap: 0 })).toEqual(["汉".repeat(10), "汉".repeat(10), "汉".repeat(10)]);
  });

  it("keeps every non-space character, in order, for many mixed texts", () => {
    // A fixed pseudo-random generator, so a failure can be repeated.
    let seed = 12345;
    const next = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const pieces = ["a", "bb", " ", "  ", "\n", "\n\n", ". ", "汉", "\u{1F600}", "x".repeat(7), "."];
    for (let run = 0; run < 200; run++) {
      const text = Array.from({ length: 1 + next(400) }, () => pieces[next(pieces.length)]!).join("");
      const size = 2 + next(60);
      const overlap = next(size);
      const chunks = chunkText(text, { size, overlap, maxChunks: 100_000 });
      for (const chunk of chunks) {
        expect(chunk.length).toBeGreaterThan(0);
        expect(chunk.length).toBeLessThanOrEqual(size);
        expect(chunk).toBe(chunk.trim());
        expect(chunk).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
      }
      const squash = (s: string) => s.replace(/\s/g, "");
      const source = squash(text);
      if (chunks.length > 0) expect(source.endsWith(squash(chunks[chunks.length - 1]!))).toBe(true);
      // With no overlap, nothing is lost or repeated: the chunks rebuild the text.
      const exact = chunkText(text, { size, overlap: 0, maxChunks: 100_000 });
      expect(squash(exact.join(""))).toBe(source);
    }
  });

  it("rejects an overlap that is not smaller than the size", () => {
    expect(() => chunkText("abc", { size: 10, overlap: 10 })).toThrow(RangeError);
    expect(() => chunkText("abc", { size: 0 })).toThrow(RangeError);
  });
});
