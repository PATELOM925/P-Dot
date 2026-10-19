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

  it("rejects an overlap that is not smaller than the size", () => {
    expect(() => chunkText("abc", { size: 10, overlap: 10 })).toThrow(RangeError);
    expect(() => chunkText("abc", { size: 0 })).toThrow(RangeError);
  });
});
