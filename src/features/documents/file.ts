// Checks for a file chosen for upload. Pure functions, so they are unit-tested.
// They mirror the API's own checks (createDocumentSchema), so the user hears
// about a problem before any text leaves the browser. Decision 0019 lists the types.
import { DOCUMENT_MEDIA_TYPE_LABELS } from "@/lib/document-types";
import {
  MAX_DOCUMENT_BODY_BYTES,
  MAX_DOCUMENT_CHARS,
  MAX_DOCUMENT_FILE_BYTES,
  MAX_DOCUMENT_TITLE_CHARS,
} from "@/lib/limits";
import type { DocumentMediaType } from "@/types/api";

/**
 * How the browser gets the text: `text` reads the file as text, `html` reads
 * it and removes the tags, `pdf` and `docx` use a library that loads only for
 * such a file, and `image` sends a smaller copy once to the image text route.
 */
export type FileKind = "text" | "html" | "pdf" | "docx" | "image";

interface FileType {
  mediaType: DocumentMediaType;
  kind: FileKind;
  /** Shown before the user adds the file. */
  label: string;
}

const text = (mediaType: DocumentMediaType, label = DOCUMENT_MEDIA_TYPE_LABELS[mediaType]): FileType => ({
  mediaType,
  kind: "text",
  label,
});
const image = (mediaType: DocumentMediaType): FileType => ({ mediaType, kind: "image", label: "Image" });

const CODE_EXTENSIONS = [
  "js", "mjs", "cjs", "jsx", "ts", "tsx", "py", "java", "go", "rs", "c", "h", "cpp", "cc", "hpp", "cs",
  "rb", "php", "sql", "sh", "bash", "zsh", "css", "scss", "swift", "kt", "kts", "r", "lua", "pl",
  "scala", "dart", "toml", "ini", "cfg", "conf",
];

const FILE_TYPES: Record<string, FileType> = {
  txt: text("text/plain"),
  text: text("text/plain"),
  md: text("text/markdown"),
  markdown: text("text/markdown"),
  csv: text("text/csv"),
  tsv: text("text/tab-separated-values"),
  tab: text("text/tab-separated-values"),
  json: text("application/json"),
  xml: text("application/xml"),
  html: { mediaType: "text/html", kind: "html", label: "HTML" },
  htm: { mediaType: "text/html", kind: "html", label: "HTML" },
  yaml: text("text/plain", "YAML"),
  yml: text("text/plain", "YAML"),
  log: text("text/plain", "Log"),
  ics: text("text/plain", "Calendar (.ics)"),
  vcf: text("text/plain", "Contact card (.vcf)"),
  rtf: text("text/plain", "Rich text (.rtf)"),
  pdf: { mediaType: "application/pdf", kind: "pdf", label: "PDF" },
  docx: {
    mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    kind: "docx",
    label: "Word",
  },
  png: image("image/png"),
  jpg: image("image/jpeg"),
  jpeg: image("image/jpeg"),
  webp: image("image/webp"),
  gif: image("image/gif"),
  ...Object.fromEntries(CODE_EXTENSIONS.map((ext) => [ext, text("text/plain", `Code (.${ext})`)])),
};

const VIDEO_AND_AUDIO = new Set([
  "mp4", "m4v", "mov", "avi", "mkv", "webm", "wmv", "flv", "mpeg", "mpg", "3gp", "ogv",
  "mp3", "wav", "m4a", "aac", "flac", "ogg", "oga", "opus", "wma", "aiff", "aif", "amr", "mid", "midi",
]);

export const UNSUPPORTED_MEDIA_MESSAGE = "Videos and audio files are not supported.";
export const SUPPORTED_SUMMARY = "text, Markdown, CSV, JSON, HTML, XML, code, PDF, Word (.docx) and images";
const UNKNOWN_TYPE_MESSAGE = `P-Dot cannot read this type of file. You can add ${SUPPORTED_SUMMARY}.`;

/** For the file picker's `accept` attribute. */
export const DOCUMENT_ACCEPT = Object.keys(FILE_TYPES)
  .map((ext) => `.${ext}`)
  .join(",");

export const MEDIA_TYPE_LABELS = DOCUMENT_MEDIA_TYPE_LABELS;

export type DescribedFile = { title: string; mediaType: DocumentMediaType; kind: FileKind; label: string };

/**
 * The title (the file name without its extension), media type, how to read
 * it and a label, or why the file cannot be used. `browserType` is the type
 * the browser gives (File.type); a video or audio type is refused also with
 * another extension.
 */
export function describeFile(fileName: string, browserType = ""): DescribedFile | { error: string } {
  const name = fileName.trim();
  const match = /^(.*)\.([^.]+)$/.exec(name);
  const extension = match ? match[2]!.toLowerCase() : "";
  if (/^(video|audio)\//i.test(browserType) || VIDEO_AND_AUDIO.has(extension)) {
    return { error: UNSUPPORTED_MEDIA_MESSAGE };
  }
  if (extension === "doc") return { error: "P-Dot cannot read old Word (.doc) files. Save the file as .docx and try again." };
  const type = match && Object.hasOwn(FILE_TYPES, extension) ? FILE_TYPES[extension] : undefined;
  if (!match || !type) return { error: UNKNOWN_TYPE_MESSAGE };
  return { title: (match[1]!.trim() || name).slice(0, MAX_DOCUMENT_TITLE_CHARS), ...type };
}

/** Checked before the file is read, so a large file is never loaded into the page. */
export function fileSizeProblem(bytes: number, kind: FileKind = "text"): string | null {
  if (kind === "text" || kind === "html") {
    return bytes > MAX_DOCUMENT_BODY_BYTES
      ? `This file is too large. Documents can have up to ${MAX_DOCUMENT_CHARS.toLocaleString()} characters.`
      : null;
  }
  return bytes > MAX_DOCUMENT_FILE_BYTES
    ? `This file is too large. PDF, Word and image files can be up to ${MAX_DOCUMENT_FILE_BYTES / (1024 * 1024)} MB.`
    : null;
}

export function textProblem(text: string): string | null {
  if (text.trim().length === 0) return "This file is empty.";
  if (text.length > MAX_DOCUMENT_CHARS) {
    return `This file has ${text.length.toLocaleString()} characters. Documents can have up to ${MAX_DOCUMENT_CHARS.toLocaleString()}.`;
  }
  return null;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/**
 * The visible text of an HTML file: no scripts, styles, comments or tags.
 * The result is stored and searched as text, never shown as HTML.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<\/?(p|div|br|li|tr|h[1-6]|section|article|header|footer|table|ul|ol)\b[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
      const lower = code.toLowerCase();
      if (lower.startsWith("#x")) return safeCodePoint(parseInt(lower.slice(2), 16)) ?? entity;
      if (lower.startsWith("#")) return safeCodePoint(parseInt(lower.slice(1), 10)) ?? entity;
      return ENTITIES[lower] ?? entity;
    })
    .replace(/[ \t\f\v\r]+/g, " ")
    .replace(/ *\n[ \n]*/g, "\n")
    .trim();
}

function safeCodePoint(code: number): string | null {
  return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : null;
}
