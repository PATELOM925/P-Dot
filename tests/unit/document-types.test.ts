import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DOCUMENT_ACCEPT,
  UNSUPPORTED_MEDIA_MESSAGE,
  describeFile,
  fileSizeProblem,
  htmlToText,
} from "@/features/documents/file";
import { DOCUMENT_MEDIA_TYPES, DOCUMENT_MEDIA_TYPE_LABELS } from "@/lib/document-types";
import { MAX_DOCUMENT_BODY_BYTES, MAX_DOCUMENT_FILE_BYTES } from "@/lib/limits";
import { createDocumentSchema } from "@/lib/schemas";

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

describe("describeFile (decision 0019)", () => {
  it.each([
    ["notes.txt", "text/plain", "text", "Plain text"],
    ["notes.text", "text/plain", "text", "Plain text"],
    ["plan.md", "text/markdown", "text", "Markdown"],
    ["sales.csv", "text/csv", "text", "CSV"],
    ["sales.tsv", "text/tab-separated-values", "text", "TSV"],
    ["data.json", "application/json", "text", "JSON"],
    ["feed.xml", "application/xml", "text", "XML"],
    ["page.html", "text/html", "html", "HTML"],
    ["page.HTM", "text/html", "html", "HTML"],
    ["config.yaml", "text/plain", "text", "YAML"],
    ["config.yml", "text/plain", "text", "YAML"],
    ["server.log", "text/plain", "text", "Log"],
    ["meeting.ics", "text/plain", "text", "Calendar (.ics)"],
    ["contact.vcf", "text/plain", "text", "Contact card (.vcf)"],
    ["letter.rtf", "text/plain", "text", "Rich text (.rtf)"],
    ["app.ts", "text/plain", "text", "Code (.ts)"],
    ["main.py", "text/plain", "text", "Code (.py)"],
    ["Main.java", "text/plain", "text", "Code (.java)"],
    ["query.sql", "text/plain", "text", "Code (.sql)"],
    ["style.css", "text/plain", "text", "Code (.css)"],
    ["report.pdf", "application/pdf", "pdf", "PDF"],
    ["Report.DOCX", DOCX, "docx", "Word"],
    ["photo.png", "image/png", "image", "Image"],
    ["photo.jpg", "image/jpeg", "image", "Image"],
    ["photo.jpeg", "image/jpeg", "image", "Image"],
    ["photo.webp", "image/webp", "image", "Image"],
    ["photo.gif", "image/gif", "image", "Image"],
  ])("%s is %s, read as %s", (name, mediaType, kind, label) => {
    expect(describeFile(name)).toMatchObject({ mediaType, kind, label });
  });

  it.each(["clip.mp4", "clip.MOV", "clip.webm", "clip.mkv", "song.mp3", "voice.m4a", "sound.wav", "sound.ogg"])(
    "refuses the video or audio file %s",
    (name) => {
      expect(describeFile(name)).toEqual({ error: UNSUPPORTED_MEDIA_MESSAGE });
    },
  );

  it("refuses a video or audio file by its browser type also with a text extension", () => {
    expect(describeFile("clip.txt", "video/mp4")).toEqual({ error: UNSUPPORTED_MEDIA_MESSAGE });
    expect(describeFile("voice.json", "audio/mpeg")).toEqual({ error: UNSUPPORTED_MEDIA_MESSAGE });
  });

  it("refuses an unknown type and lists what is supported", () => {
    const result = describeFile("setup.exe");
    expect(result).toHaveProperty("error");
    expect("error" in result && result.error).toMatch(/CSV.*PDF.*Word.*images/);
  });

  it("asks for .docx instead of an old .doc file", () => {
    expect(describeFile("old.doc")).toEqual({ error: expect.stringMatching(/\.docx/) });
  });

  it("does not take an extension from the object prototype", () => {
    expect(describeFile("x.constructor")).toHaveProperty("error");
    expect(describeFile("x.__proto__")).toHaveProperty("error");
  });

  it("every media type it gives is one the API and the database accept", () => {
    for (const ext of DOCUMENT_ACCEPT.split(",")) {
      const result = describeFile(`file${ext}`);
      expect(result).not.toHaveProperty("error");
      if (!("error" in result)) expect(DOCUMENT_MEDIA_TYPES).toContain(result.mediaType);
    }
  });
});

describe("file size checks", () => {
  it("keeps the text limit for text files", () => {
    expect(fileSizeProblem(MAX_DOCUMENT_BODY_BYTES, "text")).toBeNull();
    expect(fileSizeProblem(MAX_DOCUMENT_BODY_BYTES + 1, "text")).toMatch(/too large/);
    expect(fileSizeProblem(MAX_DOCUMENT_BODY_BYTES + 1, "html")).toMatch(/too large/);
  });

  it.each(["pdf", "docx", "image"] as const)("allows up to 10 MB for %s", (kind) => {
    expect(fileSizeProblem(MAX_DOCUMENT_BODY_BYTES + 1, kind)).toBeNull();
    expect(fileSizeProblem(MAX_DOCUMENT_FILE_BYTES, kind)).toBeNull();
    expect(fileSizeProblem(MAX_DOCUMENT_FILE_BYTES + 1, kind)).toMatch(/up to 10 MB/);
  });
});

describe("htmlToText", () => {
  it("keeps the visible text and removes scripts, styles, comments and tags", () => {
    const html =
      "<html><head><style>p{color:red}</style><script>alert('x')</script></head>" +
      "<body><!-- note --><h1>Trip</h1><p>Fish &amp; chips &#8364;5 &lt;tag&gt;</p><p>Day&nbsp;2</p></body></html>";
    expect(htmlToText(html)).toBe("Trip\nFish & chips €5 <tag>\nDay 2");
  });

  it("leaves a bad entity as it is", () => {
    expect(htmlToText("a &#99999999; b &bogus; c")).toBe("a &#99999999; b &bogus; c");
  });
});

describe("the media type list", () => {
  it("the API accepts every listed type and refuses others", () => {
    const body = { mode: "work", title: "T", text: "hello" };
    for (const mediaType of DOCUMENT_MEDIA_TYPES) {
      expect(createDocumentSchema.safeParse({ ...body, mediaType }).success).toBe(true);
      expect(DOCUMENT_MEDIA_TYPE_LABELS[mediaType]).toBeTruthy();
    }
    for (const mediaType of ["video/mp4", "audio/mpeg", "image/svg+xml", "application/msword", "IMAGE/PNG"]) {
      expect(createDocumentSchema.safeParse({ ...body, mediaType }).success).toBe(false);
    }
  });

  it("the new migration's check lists the same types", () => {
    const sql = readFileSync(
      join(process.cwd(), "supabase", "migrations", "20261101000000_document_media_types.sql"),
      "utf8",
    );
    const listed = [...sql.matchAll(/^\s+'([^']+)',?$/gm)].map((m) => m[1]);
    expect(listed).toEqual([...DOCUMENT_MEDIA_TYPES]);
  });
});
