// The media types a document can have (decision 0019). The body of every
// document is text: P-Dot reads the text out of the file at upload and keeps
// only that text. The database check on documents.media_type has the same list.

export const DOCUMENT_MEDIA_TYPES = [
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/tab-separated-values",
  "application/json",
  "text/html",
  "application/xml",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;

export type DocumentMediaType = (typeof DOCUMENT_MEDIA_TYPES)[number];

export const DOCUMENT_MEDIA_TYPE_LABELS: Record<DocumentMediaType, string> = {
  "text/plain": "Plain text",
  "text/markdown": "Markdown",
  "text/csv": "CSV",
  "text/tab-separated-values": "TSV",
  "application/json": "JSON",
  "text/html": "HTML",
  "application/xml": "XML",
  "application/pdf": "PDF",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "Word",
  "image/png": "Image text (PNG)",
  "image/jpeg": "Image text (JPEG)",
  "image/webp": "Image text (WebP)",
  "image/gif": "Image text (GIF)",
};
