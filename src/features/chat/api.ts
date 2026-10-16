import type {
  ApiErrorBody,
  ApiErrorCode,
  ChatRequest,
  ConversationDetail,
  ConversationSummary,
  Mode,
} from "@/types/api";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ApiErrorCode | "network_error",
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function toApiError(response: Response): Promise<ApiError> {
  try {
    const body = (await response.json()) as Partial<ApiErrorBody>;
    if (body.error?.message) return new ApiError(response.status, body.error.code, body.error.message);
  } catch {
    // Non-JSON error page (e.g. a platform timeout).
  }
  return new ApiError(response.status, "internal_error", "Something went wrong. Please retry.");
}

async function request(path: string, init?: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(path, { ...init, credentials: "same-origin", cache: "no-store" });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ApiError(0, "network_error", "Could not reach the server. Check your connection and retry.");
  }
  if (!response.ok) throw await toApiError(response);
  return response;
}

export async function fetchConversations(mode: Mode): Promise<ConversationSummary[]> {
  const response = await request(`/api/conversations?mode=${mode}`);
  return ((await response.json()) as { conversations: ConversationSummary[] }).conversations;
}

export async function renameConversation(id: string, title: string): Promise<ConversationSummary> {
  const response = await request(`/api/conversations/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  return (await response.json()) as ConversationSummary;
}

export async function fetchConversation(id: string): Promise<ConversationDetail> {
  const response = await request(`/api/conversations/${encodeURIComponent(id)}`);
  return (await response.json()) as ConversationDetail;
}

export async function deleteConversation(id: string): Promise<void> {
  await request(`/api/conversations/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** Starts a chat request and returns the NDJSON response body. */
export async function postChat(body: ChatRequest, signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
  const response = await request("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.body) throw new ApiError(response.status, "internal_error", "The server sent an empty response.");
  return response.body;
}
