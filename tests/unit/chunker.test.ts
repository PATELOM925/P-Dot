import { describe, expect, it } from "vitest";
import { splitIntoChunks } from "@/server/rag/chunker";

describe("splitIntoChunks", () => {
  it("returns an empty array for empty or whitespace-only text", () => {
    expect(splitIntoChunks("")).toEqual([]);
    expect(splitIntoChunks("   \n\n  \t ")).toEqual([]);
  });

  it("returns a single chunk when text is shorter than chunkSize", () => {
    const text = "This is a brief personal note about project deadlines.";
    const chunks = splitIntoChunks(text, { chunkSize: 200 });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.content).toBe(text);
    expect(chunks[0]!.chunkIndex).toBe(0);
    expect(chunks[0]!.charOffset).toBe(0);
    expect(chunks[0]!.tokenEstimate).toBeGreaterThan(0);
  });

  it("splits text on paragraph boundaries when possible", () => {
    const p1 = "First paragraph details the design specs for P-Dot AI.";
    const p2 = "Second paragraph discusses vector RAG and embedding models on Nebius.";
    const p3 = "Third paragraph outlines the testing and deployment plan.";
    const fullText = `${p1}\n\n${p2}\n\n${p3}`;

    const chunks = splitIntoChunks(fullText, { chunkSize: 90, chunkOverlap: 10 });
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks[0]!.content).toContain("First paragraph");
    expect(chunks[1]!.content).toContain("Second paragraph");
  });

  it("preserves context across boundaries through chunkOverlap", () => {
    const text =
      "Sentence one is foundational. Sentence two provides context. Sentence three adds technical requirements. Sentence four concludes the summary.";

    const chunks = splitIntoChunks(text, { chunkSize: 65, chunkOverlap: 25 });
    expect(chunks.length).toBeGreaterThan(1);

    // Adjacent chunks should overlap
    for (let i = 0; i < chunks.length - 1; i++) {
      const current = chunks[i]!.content;
      const next = chunks[i + 1]!.content;
      const currentWords = current.split(" ");
      const lastWord = currentWords[currentWords.length - 1]!;
      expect(next.includes(lastWord) || current.includes(next.split(" ")[0]!)).toBe(true);
    }
  });

  it("handles very long continuous text without whitespace gracefully", () => {
    const longToken = "A".repeat(300);
    const chunks = splitIntoChunks(longToken, { chunkSize: 100, chunkOverlap: 20 });

    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(100);
    }
  });

  it("normalizes CRLF line endings to LF", () => {
    const crlfText = "Line one\r\n\r\nLine two\r\n\r\nLine three";
    const chunks = splitIntoChunks(crlfText, { chunkSize: 50 });
    for (const c of chunks) {
      expect(c.content).not.toContain("\r");
    }
  });

  it("produces monotonically increasing chunk indices and offsets", () => {
    const doc = `
# Project Overview
P-Dot is an autonomous assistant with multi-hop tool execution.
It supports search, planning, task proposals, and personal document RAG.

## Vector Architecture
Embeddings are computed using Qwen/Qwen3-Embedding-8B on Nebius Token Factory.
Vector similarity queries run against pgvector in Supabase Postgres.
Cosine distance is used to find the top k matching chunks.
`;
    const chunks = splitIntoChunks(doc, { chunkSize: 120, chunkOverlap: 30 });
    expect(chunks.length).toBeGreaterThan(2);

    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i]!.chunkIndex).toBe(i);
      if (i > 0) {
        expect(chunks[i]!.charOffset).toBeGreaterThanOrEqual(chunks[i - 1]!.charOffset);
      }
    }
  });
});
