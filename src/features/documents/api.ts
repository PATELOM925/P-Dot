import { deleteResource, getJson, sendJson } from "@/lib/api-client";
import { REQUEST_KEY_HEADER } from "@/lib/request-key";
import type { DocumentDTO, DocumentMediaType, Mode } from "@/types/api";

export async function fetchDocuments(mode: Mode, signal?: AbortSignal): Promise<DocumentDTO[]> {
  return (await getJson<{ documents: DocumentDTO[] }>(`/api/documents?mode=${mode}`, signal)).documents;
}

/** Uploads the text. The server splits and embeds it before it answers, so this can take a few seconds. */
export async function uploadDocument(
  document: {
    mode: Mode;
    title: string;
    mediaType: DocumentMediaType;
    text: string;
  },
  requestKey: string,
): Promise<DocumentDTO> {
  return sendJson<DocumentDTO>("/api/documents", "POST", document, { [REQUEST_KEY_HEADER]: requestKey });
}

export async function deleteDocument(id: string): Promise<void> {
  await deleteResource(`/api/documents/${encodeURIComponent(id)}`);
}
