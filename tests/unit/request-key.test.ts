import { describe, expect, it } from "vitest";
import { ChatSendKey } from "@/features/chat/send-key";
import { ApiError } from "@/lib/api-client";
import { REQUEST_KEY_HEADER, RequestKey } from "@/lib/request-key";
import { REPLY_CLAIM_LEASE_SECONDS } from "@/lib/limits";
import type { MessageDTO } from "@/types/api";
import { TAVILY_TIMEOUT_MS } from "@/server/providers/tavily/client";
import { testRouting } from "../support/fakes";

function counter() {
  let n = 0;
  return () => `key-${(n += 1)}`;
}

const userMessage = (content: string): MessageDTO => ({
  id: crypto.randomUUID(),
  role: "user",
  content,
  webSearch: "off",
  sources: [],
  route: null,
  createdAt: "2026-10-21T12:00:00.000Z",
});

describe("RequestKey", () => {
  it("keeps one key while the scope stays the same, and makes a new one when it changes or is cleared", () => {
    const key = new RequestKey(counter());
    expect(key.keyFor("a")).toBe("key-1");
    expect(key.keyFor("a")).toBe("key-1");
    expect(key.keyFor("b")).toBe("key-2");
    expect(key.keyFor("a")).toBe("key-3");
    key.clear();
    expect(key.keyFor("a")).toBe("key-4");
  });

  it("makes a UUID by default", () => {
    expect(new RequestKey().keyFor("a")).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("ChatSendKey", () => {
  const header = (key: ChatSendKey, target: Parameters<ChatSendKey["headers"]>[0], text: string) =>
    key.headers(target, text)[REQUEST_KEY_HEADER];

  it("keeps the key after a lost response or a 500, so a resend of the same draft uses it", () => {
    const key = new ChatSendKey(counter());
    const first = header(key, { mode: "personal" }, "Plan my week");
    expect(key.refused(new ApiError(0, "network_error", "offline"))).toBeNull();
    expect(key.refused(new ApiError(500, "internal_error", "Something went wrong."))).toBeNull();
    expect(header(key, { mode: "personal" }, "  Plan my week ")).toBe(first);
  });

  it("makes a new key when the text, the conversation or the mode changes", () => {
    const key = new ChatSendKey(counter());
    const first = header(key, { mode: "personal" }, "Plan my week");
    expect(header(key, { mode: "personal" }, "Plan my month")).not.toBe(first);
    expect(header(key, { mode: "work" }, "Plan my month")).not.toBe(header(key, { mode: "personal" }, "Plan my month"));
    const inNew = header(key, { mode: "work" }, "Plan my month");
    expect(header(key, { conversationId: "c-1" }, "Plan my month")).not.toBe(inNew);
  });

  it("clears the key when the message is saved, so the same text later is a new message", () => {
    const key = new ChatSendKey(counter());
    const first = header(key, { conversationId: "c-1" }, "yes");
    key.saved();
    expect(header(key, { conversationId: "c-1" }, "yes")).not.toBe(first);
  });

  it("keeps the key on busy and answered, and clears it only on conflict", () => {
    const key = new ChatSendKey(counter());
    const first = header(key, { mode: "personal" }, "Plan my week");
    expect(key.refused(new ApiError(409, "busy", "P-Dot is still replying.", "c-1"))).toBe("busy");
    expect(header(key, { mode: "personal" }, "Plan my week")).toBe(first);
    expect(key.refused(new ApiError(409, "answered", "Already sent.", "c-1"))).toBe("answered");
    expect(header(key, { mode: "personal" }, "Plan my week")).toBe(first);
    expect(key.refused(new ApiError(409, "conflict", "Another message."))).toBe("conflict");
    expect(header(key, { mode: "personal" }, "Plan my week")).not.toBe(first);
  });

  it("keeps the draft's key when Retry reply gets a conflict", () => {
    const key = new ChatSendKey(counter());
    const first = header(key, { conversationId: "c-1" }, "Plan my week");
    const noUnanswered = new ApiError(409, "conflict", "There is no unanswered message to retry.");
    expect(key.refused(noUnanswered, "retry")).toBe("conflict");
    expect(header(key, { conversationId: "c-1" }, "Plan my week")).toBe(first);
    expect(key.refused(noUnanswered, "send")).toBe("conflict");
    expect(header(key, { conversationId: "c-1" }, "Plan my week")).not.toBe(first);
  });

  it("reconciles the draft only when a saved user message has its text", () => {
    const key = new ChatSendKey(counter());
    const first = header(key, { mode: "personal" }, "Plan my week");
    expect(key.reconcile([userMessage("Something else")], "Plan my week")).toBe(false);
    expect(header(key, { mode: "personal" }, "Plan my week")).toBe(first);
    expect(key.reconcile([userMessage("Plan my week")], " Plan my week ")).toBe(true);
    expect(header(key, { mode: "personal" }, "Plan my week")).not.toBe(first);
    expect(key.reconcile([userMessage("Plan my week")], "")).toBe(false);
  });
});

describe("reply claim lease", () => {
  it("is longer than the longest chat turn, with a minute to spare", () => {
    const routing = testRouting();
    // All tool hops share one tier deadline. Searches run outside it: the first search, and one web_search tool call.
    const longest = Math.max(...Object.values(routing).map((plan) => plan.deadlineMs));
    expect(REPLY_CLAIM_LEASE_SECONDS * 1000).toBeGreaterThan(longest + 2 * TAVILY_TIMEOUT_MS + 60_000);
  });
});
