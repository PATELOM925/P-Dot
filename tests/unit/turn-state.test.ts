import { describe, expect, it } from "vitest";
import { STALL_MS, TURN_STATE_LABELS, blocksRetry, canRetryLast, chatErrorView, turnStepLine, withNoRetry } from "@/features/chat/turn-state";

describe("chatErrorView", () => {
  it("uses the stream's retryable flag when it has one", () => {
    expect(chatErrorView("provider_unavailable", "The model is busy.", { retryable: true, trial: false })).toEqual({
      message: "The model is busy.",
      retryable: true,
      limit: false,
    });
    expect(chatErrorView("internal_error", "No.", { retryable: false, trial: false }).retryable).toBe(false);
  });

  it("never offers Retry for a limit, and says when for an account", () => {
    const view = chatErrorView("budget_exhausted", "Daily limit reached. Try again after 00:00 UTC.", { trial: false });
    expect(view).toEqual({ message: "Daily limit reached. Try again after 00:00 UTC.", retryable: false, limit: true });
    expect(chatErrorView("rate_limited", "Too many messages.", { retryable: true, trial: false }).retryable).toBe(false);
  });

  it("tells a trial user that the trial limit is reached", () => {
    const view = chatErrorView("rate_limited", "Too many messages.", { trial: true });
    expect(view.message).toBe("You reached the trial limit. Create an account for a higher limit.");
    expect(view.retryable).toBe(false);
  });

  it("derives retry from the code for an HTTP error before the stream", () => {
    expect(chatErrorView("network_error", "Could not reach the server.", { trial: false }).retryable).toBe(true);
    expect(chatErrorView("invalid_request", "Bad.", { trial: false }).retryable).toBe(false);
    expect(chatErrorView("not_configured", "Not set up.", { trial: false }).retryable).toBe(false);
  });

  it("names the step of a streaming reply", () => {
    const base = { text: "", searching: false };
    expect(turnStepLine({ ...base, searching: true })).toBe("Searching the web…");
    expect(turnStepLine({ ...base, tool: "Searching your documents…" })).toBe("Searching your documents…");
    expect(turnStepLine({ ...base, text: "Hi" })).toBe("Writing the reply…");
    expect(turnStepLine({ ...base, tier: "heavy" })).toBe("Thinking harder…");
    expect(turnStepLine(base)).toBe("Thinking…");
  });

  it("has one label for each state and a 30-second stall", () => {
    expect(STALL_MS).toBe(30_000);
    expect(Object.values(TURN_STATE_LABELS)).toContain("Waiting for you");
  });
});

describe("canRetryLast", () => {
  const base = { sending: false, loadingMessages: false, activeId: "c1" };
  const user = (id: string) => ({ id, role: "user" });

  it("keeps a blocked message blocked after an error on another message, for the page session", () => {
    let blocked = withNoRetry(new Set(), "msg-a");
    expect(canRetryLast({ ...base, last: user("msg-a"), noRetryIds: blocked })).toBe(false);
    blocked = withNoRetry(blocked, "msg-b");
    expect(canRetryLast({ ...base, activeId: "c2", last: user("msg-b"), noRetryIds: blocked })).toBe(false);
    expect(canRetryLast({ ...base, last: user("msg-a"), noRetryIds: blocked })).toBe(false);
    expect(canRetryLast({ ...base, last: user("msg-c"), noRetryIds: blocked })).toBe(true);
  });

  it("offers Retry only for a saved user message with no reply, when nothing is sending", () => {
    const none = new Set<string>();
    expect(canRetryLast({ ...base, last: { id: "x", role: "assistant" }, noRetryIds: none })).toBe(false);
    expect(canRetryLast({ ...base, last: { id: "x", role: "user", pending: true }, noRetryIds: none })).toBe(false);
    expect(canRetryLast({ ...base, sending: true, last: user("x"), noRetryIds: none })).toBe(false);
    expect(canRetryLast({ ...base, activeId: null, last: user("x"), noRetryIds: none })).toBe(false);
  });

  it("returns the same set when the message is already blocked", () => {
    const blocked = withNoRetry(new Set(), "msg-a");
    expect(withNoRetry(blocked, "msg-a")).toBe(blocked);
  });
});

describe("blocksRetry", () => {
  it("blocks Retry for a final error, but not for a rate limit or a spend limit", () => {
    expect(blocksRetry(chatErrorView("payload_too_large", "Too long.", { retryable: false, trial: false }))).toBe(true);
    expect(blocksRetry(chatErrorView("rate_limited", "Too many messages.", { trial: false }))).toBe(false);
    expect(blocksRetry(chatErrorView("budget_exhausted", "Daily limit.", { trial: true }))).toBe(false);
    expect(blocksRetry(chatErrorView("provider_unavailable", "Busy.", { retryable: true, trial: false }))).toBe(false);
  });
});
