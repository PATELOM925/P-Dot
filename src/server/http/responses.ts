import "server-only";
import type { ApiErrorBody, ApiErrorCode } from "@/types/api";

export function newRequestId(): string {
  return crypto.randomUUID();
}

const baseHeaders = {
  "Cache-Control": "no-store",
};

export function jsonResponse(
  data: unknown,
  requestId: string,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return Response.json(data, {
    status: init.status ?? 200,
    headers: { ...baseHeaders, "X-Request-Id": requestId, ...init.headers },
  });
}

export function errorResponse(
  status: number,
  code: ApiErrorCode,
  message: string,
  requestId: string,
  headers?: Record<string, string>,
  extra: { conversationId?: string } = {},
): Response {
  const body: ApiErrorBody = { error: { code, message, requestId, ...extra } };
  return jsonResponse(body, requestId, { status, headers });
}

export const unauthorized = (requestId: string) =>
  errorResponse(401, "unauthorized", "Sign in to continue.", requestId);

export const accountRequired = (requestId: string) =>
  errorResponse(403, "account_required", "Create an account to connect other accounts.", requestId);

export const notFound = (requestId: string) =>
  errorResponse(404, "not_found", "Conversation not found.", requestId);

export const notConfigured = (requestId: string) =>
  errorResponse(503, "not_configured", "This service is not configured yet.", requestId);
