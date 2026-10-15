import "server-only";

// Structured, metadata-only logging. Never pass message content, search
// queries, email addresses, tokens, or provider response bodies here.

type LogValue = string | number | boolean | null | undefined;

export interface LogFields {
  requestId?: string;
  route?: string;
  [key: string]: LogValue;
}

export type LogLevel = "info" | "warn" | "error";

export function logEvent(level: LogLevel, event: string, fields: LogFields = {}): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}

export type Logger = typeof logEvent;
