import { ApiError } from "@/lib/api-client";
import { REQUEST_KEY_HEADER, RequestKey } from "@/lib/request-key";
import type { MessageDTO, Mode } from "@/types/api";

/** Where a draft goes: an open conversation, or a new one in a mode. */
export type SendTarget = { conversationId: string } | { mode: Mode };

/**
 * What a 409 means for the draft (decision 0012):
 * - "busy": the message is saved and P-Dot is still replying. Keep the key and the draft.
 * - "answered": the message is saved. Reload the conversation and reconcile the draft.
 * - "conflict": the key belongs to another message. The key is cleared; the draft stays.
 */
export type SendRefusal = "busy" | "answered" | "conflict";

/** The request key of the chat draft. One key for one message, kept until the server confirms it. */
export class ChatSendKey {
  private readonly key: RequestKey;

  constructor(newKey?: () => string) {
    this.key = new RequestKey(newKey);
  }

  headers(target: SendTarget, text: string): Record<string, string> {
    const to = "conversationId" in target ? target.conversationId : `new:${target.mode}`;
    return { [REQUEST_KEY_HEADER]: this.key.keyFor(JSON.stringify([to, text.trim()])) };
  }

  /** The server saved the message (the stream started). */
  saved(): void {
    this.key.clear();
  }

  /**
   * Null for anything but a 409: the outcome is unknown, so the key stays for a
   * resend. A "Retry reply" sends no key, so its answer never clears the draft's key.
   */
  refused(error: unknown, action: "send" | "retry" = "send"): SendRefusal | null {
    if (!(error instanceof ApiError) || error.status !== 409) return null;
    if (error.code === "busy" || error.code === "answered") return error.code;
    if (action === "send") this.key.clear();
    return "conflict";
  }

  /**
   * After "answered" and a reload: true when a saved user message has the
   * draft text. Then the draft was sent, and the key is cleared.
   */
  reconcile(messages: readonly MessageDTO[], draft: string): boolean {
    const text = draft.trim();
    const sent = text.length > 0 && messages.some((message) => message.role === "user" && message.content === text);
    if (sent) this.key.clear();
    return sent;
  }
}
