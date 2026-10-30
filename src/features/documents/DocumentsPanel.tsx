"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { LocalTime, useIsClient } from "@/components/ui/LocalTime";
import { ApiError, errorMessage } from "@/lib/api-client";
import { MAX_DOCUMENT_CHARS, MAX_DOCUMENT_TITLE_CHARS } from "@/lib/limits";
import { RequestKey } from "@/lib/request-key";
import { MODE_LABELS } from "@/lib/mode";
import type { DocumentDTO, DocumentMediaType, DocumentStatus, Mode } from "@/types/api";
import { deleteDocument, fetchDocuments, readImageText, uploadDocument } from "./api";
import {
  DOCUMENT_ACCEPT,
  MEDIA_TYPE_LABELS,
  SUPPORTED_SUMMARY,
  UNSUPPORTED_MEDIA_MESSAGE,
  describeFile,
  fileSizeProblem,
  htmlToText,
  textProblem,
  type FileKind,
} from "./file";

interface PendingUpload {
  /** One ID for each file choice, so choosing a file again starts a new action. */
  choice: string;
  fileName: string;
  title: string;
  mediaType: DocumentMediaType;
  kind: FileKind;
  label: string;
  text: string;
}

const STATUS_PILLS: Record<DocumentStatus, { label: string; className: string }> = {
  processing: { label: "Processing", className: "status-proposed" },
  ready: { label: "Ready", className: "status-executed" },
  failed: { label: "Failed", className: "status-failed" },
};

function friendlyError(err: unknown, fallback: string, image = false): string {
  if (err instanceof ApiError && err.code === "not_configured") {
    return image
      ? "Reading images needs the Nebius vision model, which is not configured on this server."
      : "Adding documents needs the Nebius embedding service, which is not configured on this server.";
  }
  return errorMessage(err, fallback);
}

/**
 * The text of the file. The PDF and Word readers load only for such a file.
 * An image goes once, as a smaller JPEG copy, to the image text route.
 */
async function readText(file: File, kind: FileKind): Promise<string> {
  switch (kind) {
    case "text":
      return file.text();
    case "html":
      return htmlToText(await file.text());
    case "pdf":
      return (await import("./extract")).extractPdfText(file);
    case "docx":
      return (await import("./extract")).extractDocxText(file);
    case "image": {
      const { imageToJpegDataUrl } = await import("./extract");
      return readImageText(await imageToJpegDataUrl(file));
    }
  }
}

/** A failed upload can leave a "failed" document behind (the server keeps the row), so the list is reloaded. */
function mayHaveSaved(err: unknown): boolean {
  if (!(err instanceof ApiError)) return true;
  return err.status === 0 || (err.status >= 429 && err.code !== "not_configured");
}

/**
 * Documents for one mode: the text of files the user added (decision 0019).
 * The text is read in the browser; only an image goes to the server first, to
 * read its text. Nothing is saved until the user checks the title and presses
 * Add; deleting removes the text and its search index at once.
 */
export function DocumentsPanel({ mode, initialDocuments }: { mode: Mode; initialDocuments: DocumentDTO[] }) {
  const router = useRouter();
  // The server does not know the viewer's locale, so numbers get separators only after hydration.
  const isClient = useIsClient();
  const count = (n: number) => (isClient ? n.toLocaleString() : String(n));
  const [documents, setDocuments] = useState(initialDocuments);
  const [pending, setPending] = useState<PendingUpload | null>(null);
  const [reading, setReading] = useState<FileKind | null>(null);
  const [uploading, setUploading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  // One key for the document being added, so a resend after an error cannot add it twice.
  const [requestKey] = useState(() => new RequestKey());

  /** Shows the error, or sends the user to sign in. Returns true when the session is gone. */
  function fail(err: unknown, fallback: string, image = false): boolean {
    if (err instanceof ApiError && err.status === 401) {
      router.replace("/login?next=/memory");
      return true;
    }
    setError(friendlyError(err, fallback, image));
    return false;
  }

  async function choose(event: React.ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    // Cleared so that choosing the same file again still counts as a change.
    input.value = "";
    if (!file) return;
    setError(null);
    setPending(null);
    const described = describeFile(file.name, file.type);
    const problem = "error" in described ? described.error : fileSizeProblem(file.size, described.kind);
    if ("error" in described || problem) {
      setError(problem);
      return;
    }
    setReading(described.kind);
    try {
      const text = await readText(file, described.kind);
      const textError = textProblem(text);
      if (textError) setError(textError);
      else {
        setPending({
          choice: crypto.randomUUID(),
          fileName: file.name,
          title: described.title,
          mediaType: described.mediaType,
          kind: described.kind,
          label: described.label,
          text,
        });
      }
    } catch (err) {
      if (err instanceof Error && err.name === "FileReadError") setError(err.message);
      else if (err instanceof ApiError) fail(err, "Could not read this image.", described.kind === "image");
      else setError("Could not read this file.");
    } finally {
      setReading(null);
    }
  }

  async function reload() {
    try {
      setDocuments(await fetchDocuments(mode));
    } catch {
      // The upload error is already shown; the list stays as it was.
    }
  }

  async function add(event: React.FormEvent) {
    event.preventDefault();
    if (!pending || uploading) return;
    const title = pending.title.trim();
    if (!title) {
      setError("Give the document a title.");
      return;
    }
    setUploading(true);
    setError(null);
    try {
      const added = await uploadDocument(
        { mode, title, mediaType: pending.mediaType, text: pending.text },
        requestKey.keyFor(JSON.stringify([pending.choice, mode, title])),
      );
      requestKey.clear();
      setDocuments((list) => [added, ...list.filter((d) => d.id !== added.id)]);
      setPending(null);
      setStatus(`Added “${added.title}”.`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) requestKey.clear();
      if (!fail(err, "Could not add the document.") && mayHaveSaved(err)) void reload();
    } finally {
      setUploading(false);
    }
  }

  async function remove(document: DocumentDTO) {
    setBusyId(document.id);
    setError(null);
    try {
      await deleteDocument(document.id);
    } catch (err) {
      // Already gone counts as deleted.
      if (!(err instanceof ApiError && err.status === 404)) {
        fail(err, "Could not delete the document.");
        setBusyId(null);
        return;
      }
    }
    setDocuments((list) => list.filter((d) => d.id !== document.id));
    setConfirmId(null);
    setBusyId(null);
    setStatus(`Deleted “${document.title}”.`);
  }

  return (
    <section id="documents" className="panel" aria-labelledby="documents-heading" aria-busy={uploading}>
      <div className="panel-heading">
        <h2 id="documents-heading">Documents</h2>
        <span className="muted small">
          {documents.length === 0 ? "None yet" : `${documents.length} ${documents.length === 1 ? "document" : "documents"}`}
        </span>
      </div>
      <p className="muted small">
        Files for P-Dot to search in {MODE_LABELS[mode]} mode: {SUPPORTED_SUMMARY}, up to {count(MAX_DOCUMENT_CHARS)}{" "}
        characters of text each. P-Dot reads the text in your browser and sends it to Nebius once, to make it
        searchable. For an image, P-Dot sends a smaller copy to Nebius once to read it. We keep the text and a
        description, not the image. {UNSUPPORTED_MEDIA_MESSAGE}
      </p>

      {pending ? (
        <form className="document-pending stack" onSubmit={(event) => void add(event)} aria-label="Add this document">
          <div className="field">
            <label htmlFor="document-title">Title</label>
            <input
              id="document-title"
              className="form-control"
              type="text"
              value={pending.title}
              maxLength={MAX_DOCUMENT_TITLE_CHARS}
              autoFocus
              onChange={(event) => setPending({ ...pending, title: event.target.value })}
            />
          </div>
          <p className="hint">
            {pending.fileName} · {pending.label} · {count(pending.text.length)} characters
          </p>
          {pending.kind === "image" && (
            <p className="hint">We keep the text and a description, not the image.</p>
          )}
          <details className="hint">
            <summary>Show the text</summary>
            <p className="document-preview">{pending.text.slice(0, 2_000)}{pending.text.length > 2_000 ? "…" : ""}</p>
          </details>
          <div className="actions">
            <button type="submit" className="button button-primary" disabled={uploading || !pending.title.trim()}>
              {uploading ? "Adding…" : "Add document"}
            </button>
            <button type="button" className="button" disabled={uploading} onClick={() => setPending(null)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="actions">
          <input
            id="document-file"
            className="file-input visually-hidden"
            type="file"
            accept={DOCUMENT_ACCEPT}
            disabled={reading !== null}
            onChange={(event) => void choose(event)}
          />
          <label htmlFor="document-file" className="button" aria-disabled={reading !== null || undefined}>
            {reading === "image" ? "Reading the image…" : reading ? "Reading…" : "Choose a file"}
          </label>
          <span className="hint">Text, CSV, PDF, Word, images and more. Up to 10 MB.</span>
        </div>
      )}

      {error && (
        <p className="alert alert-error small" role="alert">
          {error}
        </p>
      )}

      {documents.length > 0 && (
        <ul className="document-list">
          {documents.map((document) => {
            const pill = STATUS_PILLS[document.status];
            return (
              <li key={document.id} className="document-item">
                <div className="document-body">
                  <span className="document-title">{document.title}</span>
                  <span className="hint">
                    {MEDIA_TYPE_LABELS[document.mediaType]} · {count(document.charCount)} characters ·{" "}
                    <LocalTime iso={document.createdAt} style="date" />
                  </span>
                  {document.status === "failed" && (
                    <span className="hint">Could not be processed. Delete it and add the file again.</span>
                  )}
                  {document.status === "processing" && (
                    <span className="hint">Still processing. If this does not change, delete it and add the file again.</span>
                  )}
                </div>
                <span className={`status-pill ${pill.className}`}>{pill.label}</span>
                {confirmId === document.id ? (
                  <div className="actions" role="group" aria-label={`Delete “${document.title}”?`}>
                    <span className="small">Delete this document? Its text is removed at once.</span>
                    <button
                      type="button"
                      className="button button-danger button-small"
                      disabled={busyId === document.id}
                      onClick={() => void remove(document)}
                    >
                      {busyId === document.id ? "Deleting…" : "Delete"}
                    </button>
                    <button
                      type="button"
                      className="button button-small"
                      disabled={busyId === document.id}
                      onClick={() => setConfirmId(null)}
                    >
                      Keep it
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="button button-small button-danger"
                    aria-label={`Delete “${document.title}”`}
                    onClick={() => setConfirmId(document.id)}
                  >
                    Delete
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <p className="visually-hidden" role="status" aria-live="polite">
        {status}
      </p>
    </section>
  );
}
