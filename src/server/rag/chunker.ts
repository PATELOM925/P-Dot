import "server-only";

export interface ChunkOptions {
  /** Maximum character length per chunk. Default 500 characters (~100-125 tokens). */
  chunkSize?: number;
  /** Overlap in characters between adjacent chunks. Default 50 characters. */
  chunkOverlap?: number;
  /** Priority separators for natural splitting. */
  separators?: string[];
}

export interface DocumentChunk {
  content: string;
  chunkIndex: number;
  charOffset: number;
  tokenEstimate: number;
}

const DEFAULT_SEPARATORS = ["\n\n", "\n", ". ", "; ", ", ", " "];
const DEFAULT_CHUNK_SIZE = 500;
const DEFAULT_CHUNK_OVERLAP = 50;

/**
 * Splits document text into semantically cohesive, overlapping chunks
 * using priority separators and a strict upper bound on chunk size.
 */
export function splitIntoChunks(text: string, options: ChunkOptions = {}): DocumentChunk[] {
  const chunkSize = Math.max(20, options.chunkSize ?? DEFAULT_CHUNK_SIZE);
  const chunkOverlap = Math.max(0, Math.min(Math.floor(chunkSize / 2), options.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP));
  const separators = options.separators ?? DEFAULT_SEPARATORS;

  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (normalized.length === 0) {
    return [];
  }

  // Fast path for small documents
  if (normalized.length <= chunkSize) {
    return [
      {
        content: normalized,
        chunkIndex: 0,
        charOffset: 0,
        tokenEstimate: Math.max(1, Math.ceil(normalized.length / 4)),
      },
    ];
  }

  const chunks: DocumentChunk[] = [];
  let cursor = 0;

  while (cursor < normalized.length) {
    const targetEnd = Math.min(normalized.length, cursor + chunkSize);

    if (targetEnd === normalized.length) {
      const remaining = normalized.slice(cursor).trim();
      if (remaining.length > 0) {
        chunks.push({
          content: remaining,
          chunkIndex: chunks.length,
          charOffset: cursor,
          tokenEstimate: Math.max(1, Math.ceil(remaining.length / 4)),
        });
      }
      break;
    }

    // Window slice to search for a natural breakpoint
    const windowSlice = normalized.slice(cursor, targetEnd);
    let splitPoint = -1;

    // Search separators from highest priority (\n\n) to lowest (' ')
    for (const sep of separators) {
      const lastIndex = windowSlice.lastIndexOf(sep);
      // We want the break to be after some minimum content to prevent tiny chunks
      if (lastIndex !== -1 && lastIndex >= chunkOverlap) {
        splitPoint = cursor + lastIndex + sep.length;
        break;
      }
    }

    // If no good separator found in the window, hard cut at targetEnd
    if (splitPoint === -1) {
      splitPoint = targetEnd;
    }

    const chunkText = normalized.slice(cursor, splitPoint).trim();
    if (chunkText.length > 0) {
      chunks.push({
        content: chunkText,
        chunkIndex: chunks.length,
        charOffset: cursor,
        tokenEstimate: Math.max(1, Math.ceil(chunkText.length / 4)),
      });
    }

    // Advance cursor with overlap
    const nextCursor = splitPoint - chunkOverlap;
    cursor = nextCursor > cursor ? nextCursor : cursor + 1;
  }

  return chunks;
}
