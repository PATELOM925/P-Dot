import { describe, expect, it } from "vitest";
import { STICK_PX, isNearBottom } from "@/features/chat/useStickToBottom";

describe("isNearBottom", () => {
  const at = (fromBottom: number) => ({ scrollHeight: 2000, clientHeight: 600, scrollTop: 2000 - 600 - fromBottom });

  it("follows at the bottom and up to 79 px above it", () => {
    expect(isNearBottom(at(0))).toBe(true);
    expect(isNearBottom(at(STICK_PX - 1))).toBe(true);
  });

  it("stops following 80 px or more above the bottom", () => {
    expect(isNearBottom(at(STICK_PX))).toBe(false);
    expect(isNearBottom(at(81))).toBe(false);
  });
});
