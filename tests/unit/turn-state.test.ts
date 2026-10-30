import { describe, expect, it } from "vitest";
import { STALL_MS, TURN_STATE_LABELS, chatErrorView } from "@/features/chat/turn-state";

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

  it("has one label for each state and a 15-second stall", () => {
    expect(STALL_MS).toBe(15_000);
    expect(Object.values(TURN_STATE_LABELS)).toContain("Waiting for you");
  });
});
