// Checks for a file chosen for upload. Pure functions, so they are unit-tested.
// They mirror the API's own checks (createDocumentSchema), so the user hears
// about a problem before any text leaves the browser.
import { MAX_DOCUMENT_BODY_BYTES, MAX_DOCUMENT_CHARS, MAX_DOCUMENT_TITLE_CHARS } from "@/lib/limits";
import type { DocumentMediaType } from "@/types/api";

const EXTENSIONS: Record<string, DocumentMediaType> = {
  txt: "text/plain",
  text: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
};

/** For the file picker's `accept` attribute. */
export const DOCUMENT_ACCEPT = ".txt,.text,.md,.markdown,text/plain,text/markdown";

export const MEDIA_TYPE_LABELS: Record<DocumentMediaType, string> = {
  "text/plain": "Plain text",
  "text/markdown": "Markdown",
};

/** The title (the file name without its extension) and media type, or why the file cannot be used. */
export function describeFile(fileName: string): { title: string; mediaType: DocumentMediaType } | { error: string } {
  const name = fileName.trim();
  const match = /^(.*)\.([^.]+)$/.exec(name);
  const mediaType = match ? EXTENSIONS[match[2]!.toLowerCase()] : undefined;
  if (!match || !mediaType) return { error: "Choose a plain text (.txt) or Markdown (.md) file." };
  return { title: (match[1]!.trim() || name).slice(0, MAX_DOCUMENT_TITLE_CHARS), mediaType };
}

/** Checked before the file is read, so a large file is never loaded into the page. */
export function fileSizeProblem(bytes: number): string | null {
  return bytes > MAX_DOCUMENT_BODY_BYTES
    ? `This file is too large. Documents can have up to ${MAX_DOCUMENT_CHARS.toLocaleString()} characters.`
    : null;
}

export function textProblem(text: string): string | null {
  if (text.trim().length === 0) return "This file is empty.";
  if (text.length > MAX_DOCUMENT_CHARS) {
    return `This file has ${text.length.toLocaleString()} characters. Documents can have up to ${MAX_DOCUMENT_CHARS.toLocaleString()}.`;
  }
  return null;
}
