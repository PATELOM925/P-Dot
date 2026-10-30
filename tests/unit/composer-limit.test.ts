import { describe, expect, it } from "vitest";
import { composerLimit } from "@/features/chat/composer-limit";
import { MAX_MESSAGE_CHARS } from "@/lib/limits";

describe("composerLimit", () => {
  it("hides the counter well under the limit", () => {
    expect(composerLimit(100)).toEqual({ showCount: false, over: false, message: null });
  });

  it("shows the counter near the limit, with no message", () => {
    const near = composerLimit(Math.floor(MAX_MESSAGE_CHARS * 0.9));
    expect(near.showCount).toBe(true);
    expect(near.over).toBe(false);
    expect(near.message).toBeNull();
    expect(composerLimit(MAX_MESSAGE_CHARS).over).toBe(false);
  });

  it("says how much to remove when a long paste is over the limit", () => {
    const over = composerLimit(20_000);
    expect(over.over).toBe(true);
    expect(over.showCount).toBe(true);
    expect(over.message).toContain("20,000 characters");
    expect(over.message).toContain("The limit is 4,000");
    expect(over.message).toContain("Remove 16,000 characters");
  });
});
