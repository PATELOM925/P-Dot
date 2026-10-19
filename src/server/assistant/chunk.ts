import { DOCUMENT_CHUNK_CHARS, DOCUMENT_CHUNK_OVERLAP_CHARS, MAX_DOCUMENT_CHUNKS } from "@/lib/limits";

export interface ChunkOptions {
  /** Most characters in one chunk, before trimming. */
  size?: number;
  /** About how many characters each chunk shares with the next one. */
  overlap?: number;
  /** Throw when more chunks than this would be needed. */
  maxChunks?: number;
}

/**
 * Split points, most preferred first. `keep` is how many characters of the
 * separator stay at the end of the chunk. A split is tried only if it leaves
 * at least half a chunk, so chunks do not become tiny.
 */
const SPLITS: { separator: string; keep: number }[] = [
  { separator: "\n\n", keep: 2 },
  { separator: "\n", keep: 1 },
  { separator: ". ", keep: 1 },
  { separator: " ", keep: 1 },
];

/**
 * Splits text into overlapping chunks for search. Pure: no I/O.
 *
 * Each chunk is trimmed, never empty, and at most `size` characters. The
 * split prefers a blank line, then a newline, then a sentence end, then a
 * space. It cuts in the middle of a word only when the text has no such
 * point in the window. Consecutive chunks share about `overlap` characters.
 */
export function chunkText(text: string, options: ChunkOptions = {}): string[] {
  const size = options.size ?? DOCUMENT_CHUNK_CHARS;
  const overlap = options.overlap ?? DOCUMENT_CHUNK_OVERLAP_CHARS;
  const maxChunks = options.maxChunks ?? MAX_DOCUMENT_CHUNKS;
  // At least 2, so a hard cut can step back over half of a character pair.
  if (!Number.isInteger(size) || size < 2) throw new RangeError("Chunk size must be a whole number of at least 2.");
  if (!Number.isInteger(overlap) || overlap < 0 || overlap >= size) {
    throw new RangeError("Chunk overlap must be a whole number from 0 up to the chunk size.");
  }

  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const cut = findCut(text, start, size, overlap);
    const piece = text.slice(start, cut).trim();
    if (piece.length > 0) {
      if (chunks.length === maxChunks) {
        throw new Error(`The text needs more than ${maxChunks} chunks.`);
      }
      chunks.push(piece);
    }
    if (cut >= text.length) break;
    start = nextStart(text, start, cut, overlap);
  }
  return chunks;
}

/** The end of the chunk that starts at `start`. Always after `start + overlap`. */
function findCut(text: string, start: number, size: number, overlap: number): number {
  const hardEnd = Math.min(start + size, text.length);
  if (hardEnd === text.length) return hardEnd;

  // The split must leave room for the overlap, so the next chunk moves forward.
  const earliest = start + Math.max(Math.floor(size / 2), overlap + 1);
  for (const { separator, keep } of SPLITS) {
    const index = text.lastIndexOf(separator, start + size - keep);
    if (index < 0) continue;
    const cut = index + keep;
    if (cut >= earliest && cut <= hardEnd) return cut;
  }
  // A hard cut must not split an emoji or other surrogate pair.
  return isHighSurrogate(text.charCodeAt(hardEnd - 1)) ? hardEnd - 1 : hardEnd;
}

/**
 * Where the next chunk starts: `overlap` characters before `cut`, moved
 * forward to the next word start so the chunk does not begin mid-word.
 * Always after `start`, so the loop ends.
 */
function nextStart(text: string, start: number, cut: number, overlap: number): number {
  let next = Math.max(cut - overlap, start + 1);
  if (isLowSurrogate(text.charCodeAt(next)) && isHighSurrogate(text.charCodeAt(next - 1))) next += 1;
  if (!/\s/.test(text[next - 1]!)) {
    for (let i = next; i < cut; i++) {
      if (/\s/.test(text[i]!)) {
        next = i + 1;
        break;
      }
    }
  }
  return next;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
