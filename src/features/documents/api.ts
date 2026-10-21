import { deleteResource, getJson, sendJson } from "@/lib/api-client";
import type { DocumentDTO, DocumentMediaType, Mode } from "@/types/api";

export async function fetchDocuments(mode: Mode, signal?: AbortSignal): Promise<DocumentDTO[]> {
  return (await getJson<{ documents: DocumentDTO[] }>(`/api/documents?mode=${mode}`, signal)).documents;
}

/** Uploads the text. The server splits and embeds it before it answers, so this can take a few seconds. */
export async function uploadDocument(document: {
  mode: Mode;
  title: string;
  mediaType: DocumentMediaType;
  text: string;
}): Promise<DocumentDTO> {
  return sendJson<DocumentDTO>("/api/documents", "POST", document);
}

export async function deleteDocument(id: string): Promise<void> {
  await deleteResource(`/api/documents/${encodeURIComponent(id)}`);
}
