import { describe, expect, it, vi } from "vitest";
import { createMockDocumentRepository } from "@/server/db/documents";
import { ingestDocumentText } from "@/server/rag/ingestion";

describe("DocumentRepository (Mock)", () => {
  it("creates, retrieves, and lists documents for a user", async () => {
    const repo = createMockDocumentRepository();
    const doc = await repo.createDocument("user-1", {
      filename: "notes.txt",
      fileSize: 100,
      mimeType: "text/plain",
    });

    expect(doc.id).toBeDefined();
    expect(doc.filename).toBe("notes.txt");
    expect(doc.userId).toBe("user-1");

    const fetched = await repo.getDocument("user-1", doc.id);
    expect(fetched).toEqual(doc);

    const list = await repo.listDocuments("user-1");
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(doc.id);
  });

  it("enforces strict user isolation across accounts", async () => {
    const repo = createMockDocumentRepository();
    const docA = await repo.createDocument("user-A", {
      filename: "secret-a.txt",
      fileSize: 50,
    });

    // User B should not see user A's document
    const listB = await repo.listDocuments("user-B");
    expect(listB).toHaveLength(0);

    const fetchedByB = await repo.getDocument("user-B", docA.id);
    expect(fetchedByB).toBeNull();

    const deletedByB = await repo.deleteDocument("user-B", docA.id);
    expect(deletedByB).toBe(false);
  });

  it("inserts chunks and performs semantic vector search with similarity threshold", async () => {
    const repo = createMockDocumentRepository();
    const doc = await repo.createDocument("user-1", {
      filename: "architecture.md",
      fileSize: 500,
    });

    // Add 2 chunks with distinct mock embedding vectors
    await repo.insertChunks("user-1", [
      {
        documentId: doc.id,
        chunkIndex: 0,
        content: "Nebius Token Factory hosts Qwen3-Embedding-8B for vector RAG.",
        embedding: [1, 0, 0, 0],
      },
      {
        documentId: doc.id,
        chunkIndex: 1,
        content: "Supabase provides pgvector with HNSW indexing for high speed retrieval.",
        embedding: [0, 1, 0, 0],
      },
    ]);

    // Query close to chunk 0
    const query0 = [0.99, 0.05, 0, 0];
    const matches0 = await repo.searchChunks("user-1", query0, { threshold: 0.5 });
    expect(matches0.length).toBeGreaterThanOrEqual(1);
    expect(matches0[0]!.content).toContain("Nebius Token Factory");
    expect(matches0[0]!.similarity).toBeGreaterThan(0.9);

    // Query close to chunk 1
    const query1 = [0.05, 0.99, 0, 0];
    const matches1 = await repo.searchChunks("user-1", query1, { threshold: 0.5 });
    expect(matches1.length).toBeGreaterThanOrEqual(1);
    expect(matches1[0]!.content).toContain("Supabase provides pgvector");
    expect(matches1[0]!.similarity).toBeGreaterThan(0.9);

    // Different user cannot search user-1's chunks
    const matchesOther = await repo.searchChunks("user-2", query0, { threshold: 0.1 });
    expect(matchesOther).toHaveLength(0);
  });

  it("deleting a document cascades and removes its vector chunks", async () => {
    const repo = createMockDocumentRepository();
    const doc = await repo.createDocument("user-1", {
      filename: "temp.txt",
      fileSize: 100,
    });

    await repo.insertChunks("user-1", [
      {
        documentId: doc.id,
        chunkIndex: 0,
        content: "Ephemeral knowledge to be removed.",
        embedding: [1, 1, 1, 1],
      },
    ]);

    const beforeDelete = await repo.searchChunks("user-1", [1, 1, 1, 1], { threshold: 0.5 });
    expect(beforeDelete).toHaveLength(1);

    const deleted = await repo.deleteDocument("user-1", doc.id);
    expect(deleted).toBe(true);

    const afterDelete = await repo.searchChunks("user-1", [1, 1, 1, 1], { threshold: 0.5 });
    expect(afterDelete).toHaveLength(0);
  });
});

describe("ingestDocumentText", () => {
  it("chunks document, computes batch embeddings, and persists all chunks", async () => {
    const repo = createMockDocumentRepository();
    const mockEmbed = vi.fn(async (texts: string[]) => ({
      embeddings: texts.map((_, i) => [i * 0.1, 0.5]),
    }));

    const text = `
Chapter 1: The Foundations of P-Dot AI.
This system integrates model inference with multi-hop tool execution.

Chapter 2: Vector RAG.
Personal documents are parsed, chunked, embedded, and queried with pgvector.
`;

    const result = await ingestDocumentText({
      repo,
      embed: mockEmbed,
      userId: "user-123",
      filename: "guide.txt",
      content: text,
      options: { chunkSize: 120, chunkOverlap: 20 },
    });

    expect(result.document.filename).toBe("guide.txt");
    expect(result.chunkCount).toBeGreaterThan(1);
    expect(mockEmbed).toHaveBeenCalled();

    const storedDocs = await repo.listDocuments("user-123");
    expect(storedDocs).toHaveLength(1);
  });

  it("rejects empty or whitespace-only content", async () => {
    const repo = createMockDocumentRepository();
    const mockEmbed = vi.fn();

    await expect(
      ingestDocumentText({
        repo,
        embed: mockEmbed,
        userId: "user-1",
        filename: "empty.txt",
        content: "    ",
      }),
    ).rejects.toThrow("Document content cannot be empty.");
  });
});
