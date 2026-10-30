// Reads the text out of a PDF or Word file, and makes a smaller copy of an
// image, in the browser (decision 0019). The PDF and Word libraries load only
// when such a file is chosen, so the main bundle does not grow.
import { IMAGE_MAX_SIDE_PX, MAX_IMAGE_TEXT_BODY_BYTES } from "@/lib/limits";

/** A problem with the file that the user can act on. The message is shown as it is. */
export class FileReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileReadError";
  }
}

export const NO_PDF_TEXT_MESSAGE = "This PDF has no text we can read. Try an image of the page instead.";

interface PdfTextItem {
  str?: string;
  hasEOL?: boolean;
}

export async function extractPdfText(file: File): Promise<string> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // The parser runs on the page, not in a worker: pdf.js uses this module when it is set.
  const holder = globalThis as { pdfjsWorker?: unknown };
  holder.pdfjsWorker ??= await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
  const task = pdfjs.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    disableFontFace: true,
    useSystemFonts: false,
    enableXfa: false,
  });
  let pdf;
  try {
    pdf = await task.promise;
  } catch (error) {
    void task.destroy();
    if (error instanceof Error && error.name === "PasswordException") {
      throw new FileReadError("This PDF has a password. Remove the password and try again.");
    }
    throw new FileReadError("Could not read this PDF.");
  }
  try {
    const pages: string[] = [];
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number);
      const content = await page.getTextContent();
      pages.push(
        (content.items as PdfTextItem[])
          .map((item) => (item.str ?? "") + (item.hasEOL ? "\n" : ""))
          .join("")
          .trim(),
      );
      page.cleanup();
    }
    const text = pages.filter(Boolean).join("\n\n");
    if (text.trim().length === 0) throw new FileReadError(NO_PDF_TEXT_MESSAGE);
    return text;
  } finally {
    void task.destroy();
  }
}

export async function extractDocxText(file: File): Promise<string> {
  const mammoth = (await import("mammoth/mammoth.browser.js")).default;
  try {
    const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
    return result.value.trim();
  } catch {
    throw new FileReadError("Could not read this Word file. Save it again as .docx and try again.");
  }
}

/** Bytes of a data URL in the JSON body, with room for the rest of the body. */
const BODY_ROOM_BYTES = 1_024;

/**
 * A JPEG copy of the image with the long side at most IMAGE_MAX_SIDE_PX, as
 * a data URL. For a GIF, only the first frame. Lower quality is tried when
 * the copy is too large for the route.
 */
export async function imageToJpegDataUrl(file: File): Promise<string> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new FileReadError("Could not open this image.");
  }
  const scale = Math.min(1, IMAGE_MAX_SIDE_PX / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new FileReadError("Could not open this image.");
  // A white background, so transparent parts do not turn black in the JPEG.
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  for (const quality of [0.85, 0.7, 0.5, 0.35]) {
    const url = canvas.toDataURL("image/jpeg", quality);
    if (url.startsWith("data:image/jpeg;base64,") && url.length + BODY_ROOM_BYTES <= MAX_IMAGE_TEXT_BODY_BYTES) return url;
  }
  throw new FileReadError("This image is too large to read. Try a smaller image.");
}
