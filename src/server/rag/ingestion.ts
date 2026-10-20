import "server-only";
import type { DocumentRepository, NewChunk, UserDocument } from "@/server/db/documents";
import { splitIntoChunks, type ChunkOptions } from "./chunker";

export interface IngestDocumentInput {
  repo: DocumentRepository;
  embed: (texts: string[]) => Promise<{ embeddings: number[][] }>;
  userId: string;
  filename: string;
  content: string;
  mimeType?: string;
  options?: ChunkOptions;
}

export interface IngestDocumentResult {
  document: UserDocument;
  chunkCount: number;
  totalTokensEstimate: number;
}

const BATCH_SIZE = 16;

/**
 * Orchestrates document chunking, vector embedding generation,
 * and persistence in the user's vector repository.
 */
export async function ingestDocumentText(input: IngestDocumentInput): Promise<IngestDocumentResult> {
  const { repo, embed, userId, filename, content, mimeType, options } = input;

  const trimmed = content.trim();
  if (trimmed.length === 0) {
    throw new Error("Document content cannot be empty.");
  }

  const chunks = splitIntoChunks(trimmed, options);
  if (chunks.length === 0) {
    throw new Error("Failed to produce chunks from document content.");
  }

  // 1. Create document record
  const document = await repo.createDocument(userId, {
    filename: filename.trim(),
    fileSize: Buffer.byteLength(trimmed, "utf8"),
    mimeType: mimeType ?? "text/plain",
  });

  // 2. Batch embeddings generation
  const allEmbeddings: number[][] = [];
  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);
    const batchTexts = batch.map((c) => c.content);
    const result = await embed(batchTexts);
    allEmbeddings.push(...result.embeddings);
  }

  if (allEmbeddings.length !== chunks.length) {
    throw new Error("Mismatch between chunk count and generated embeddings.");
  }

  // 3. Assemble and persist chunk records
  const newChunks: NewChunk[] = chunks.map((chunk, index) => ({
    documentId: document.id,
    chunkIndex: chunk.chunkIndex,
    content: chunk.content,
    embedding: allEmbeddings[index]!,
  }));

  await repo.insertChunks(userId, newChunks);

  const totalTokensEstimate = chunks.reduce((acc, c) => acc + c.tokenEstimate, 0);

  return {
    document,
    chunkCount: chunks.length,
    totalTokensEstimate,
  };
}
