import "server-only";
import {
  DOCUMENT_CONTEXT_MAX_CHARS,
  DOCUMENT_CONTEXT_MAX_CHUNKS,
  DOCUMENT_CONTEXT_MAX_DOCUMENTS,
  DOCUMENT_FULL_CONTEXT_CHARS,
  DOCUMENT_MATCH_MIN_SIMILARITY,
} from "@/lib/limits";
import type { DocumentChunkMatch, ReadyDocument, RetrievalRepository } from "@/server/db/retrieval";

/**
 * How a chat turn gets the user's documents. Small documents go in full on
 * every turn, with no embedding call. Larger ones: the best search matches
 * for the message, from the embedding the memory lookup makes anyway.
 */
export type DocumentPlan = { kind: "full"; documents: ReadyDocument[] } | { kind: "search" };

/** The document text one turn sends, by title, and the parts it came from. */
export interface DocumentContext {
  sources: { title: string; content: string }[];
  chunkIds: string[];
}

export const NO_DOCUMENTS: DocumentContext = { sources: [], chunkIds: [] };

/** `documents` is a read of at most DOCUMENT_CONTEXT_MAX_DOCUMENTS + 1 ready documents. */
export function planDocumentContext(documents: ReadyDocument[]): DocumentPlan | null {
  if (documents.length === 0) return null;
  const total = documents.reduce((sum, document) => sum + document.charCount, 0);
  if (documents.length > DOCUMENT_CONTEXT_MAX_DOCUMENTS || total > DOCUMENT_FULL_CONTEXT_CHARS) return { kind: "search" };
  return { kind: "full", documents };
}

/** Keeps the total text within DOCUMENT_CONTEXT_MAX_CHARS, the size the spend hold prices. */
function capped(context: DocumentContext): DocumentContext {
  let left = DOCUMENT_CONTEXT_MAX_CHARS;
  const sources: DocumentContext["sources"] = [];
  for (const source of context.sources) {
    if (left <= 0) break;
    sources.push({ title: source.title, content: source.content.slice(0, left) });
    left -= source.content.length;
  }
  return { sources, chunkIds: context.chunkIds };
}

/** Every part of the small documents, joined in order, one source for each document. */
export async function fullDocumentContext(
  retrieval: Pick<RetrievalRepository, "documentChunks">,
  userId: string,
  documents: ReadyDocument[],
): Promise<DocumentContext> {
  const chunks = await retrieval.documentChunks(
    userId,
    documents.map((document) => document.id),
    DOCUMENT_CONTEXT_MAX_CHUNKS,
  );
  const sources = documents
    .map((document) => ({
      title: document.title,
      content: chunks
        .filter((chunk) => chunk.documentId === document.id)
        .map((chunk) => chunk.content)
        .join("\n"),
    }))
    .filter((source) => source.content.length > 0);
  return capped({ sources, chunkIds: chunks.map((chunk) => chunk.id) });
}

/** Search matches above the noise floor, best first. */
export function matchedDocumentContext(matches: DocumentChunkMatch[]): DocumentContext {
  const kept = matches.filter((match) => match.similarity >= DOCUMENT_MATCH_MIN_SIMILARITY);
  return capped({
    sources: kept.map((match) => ({ title: match.title, content: match.content })),
    chunkIds: kept.map((match) => match.id),
  });
}
