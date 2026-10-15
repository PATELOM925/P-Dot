import { describe, expect, it } from "vitest";
import { MAX_MESSAGE_CHARS } from "@/lib/limits";
import { safeNextPath, toSafeHttpUrl } from "@/lib/safe-url";
import { chatRequestSchema, newPasswordSchema } from "@/lib/schemas";

const ID = "3f8e2a4c-9b1d-4e7f-8a2b-1c3d5e7f9a0b";

describe("chatRequestSchema", () => {
  it("accepts a new message and trims it", () => {
    const result = chatRequestSchema.safeParse({ action: "send", message: "  hi  ", webSearch: false });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ action: "send", message: "hi", webSearch: false });
  });

  it("accepts a message for an existing conversation", () => {
    const result = chatRequestSchema.safeParse({ action: "send", conversationId: ID, message: "hi", webSearch: true });
    expect(result.success).toBe(true);
  });

  it.each([
    ["empty message", { action: "send", message: "   ", webSearch: false }],
    ["too long", { action: "send", message: "x".repeat(MAX_MESSAGE_CHARS + 1), webSearch: false }],
    ["missing webSearch", { action: "send", message: "hi" }],
    ["non-boolean webSearch", { action: "send", message: "hi", webSearch: "yes" }],
    ["malformed conversation ID", { action: "send", conversationId: "123", message: "hi", webSearch: false }],
    ["client-supplied user ID", { action: "send", message: "hi", webSearch: false, userId: ID }],
    ["retry without conversation", { action: "retry", webSearch: false }],
    ["retry with a message", { action: "retry", conversationId: ID, message: "hi", webSearch: false }],
    ["unknown action", { action: "delete", conversationId: ID, webSearch: false }],
    ["not an object", "hello"],
  ])("rejects %s", (_label, body) => {
    expect(chatRequestSchema.safeParse(body).success).toBe(false);
  });

  it("accepts a message at exactly the limit", () => {
    const body = { action: "send", message: "x".repeat(MAX_MESSAGE_CHARS), webSearch: false };
    expect(chatRequestSchema.safeParse(body).success).toBe(true);
  });
});

describe("newPasswordSchema", () => {
  it("requires at least 8 characters", () => {
    expect(newPasswordSchema.safeParse("short").success).toBe(false);
    expect(newPasswordSchema.safeParse("long enough").success).toBe(true);
  });

  it("rejects passwords longer than 72 bytes", () => {
    expect(newPasswordSchema.safeParse("é".repeat(37)).success).toBe(false); // 74 bytes
    expect(newPasswordSchema.safeParse("a".repeat(72)).success).toBe(true);
  });
});

describe("toSafeHttpUrl", () => {
  it.each(["https://example.com/a?b=1", "http://example.org/"])("allows %s", (url) => {
    expect(toSafeHttpUrl(url)).toBe(new URL(url).toString());
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "ftp://example.com/file",
    "https://user:pass@example.com/",
    "not a url",
    "",
    42,
    null,
  ])("rejects %s", (url) => {
    expect(toSafeHttpUrl(url)).toBeNull();
  });
});

describe("safeNextPath", () => {
  it("keeps same-origin paths", () => {
    expect(safeNextPath("/chat?c=1")).toBe("/chat?c=1");
    expect(safeNextPath("/settings")).toBe("/settings");
  });

  it.each(["https://evil.example", "//evil.example", "/\\evil.example", "chat", "", undefined, "/x\u0000"])(
    "falls back for %s",
    (value) => {
      expect(safeNextPath(value)).toBe("/chat");
    },
  );
});
