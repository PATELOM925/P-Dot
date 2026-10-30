import { describe, expect, it } from "vitest";
import { NO_OVERFLOW, railArrows, railStep, sameArrows } from "@/components/ui/card-rail";

describe("CardRail arrows", () => {
  it("hides both arrows when every card fits", () => {
    expect(railArrows({ scrollLeft: 0, clientWidth: 900, scrollWidth: 900 })).toEqual(NO_OVERFLOW);
    expect(railArrows({ scrollLeft: 0, clientWidth: 900, scrollWidth: 600 })).toEqual(NO_OVERFLOW);
  });

  it("treats a sub-pixel overflow as a fit", () => {
    expect(railArrows({ scrollLeft: 0, clientWidth: 900, scrollWidth: 901.5 })).toEqual(NO_OVERFLOW);
  });

  it("disables Previous at the start and Next at the end", () => {
    expect(railArrows({ scrollLeft: 0, clientWidth: 360, scrollWidth: 1300 })).toEqual({ overflow: true, canPrev: false, canNext: true });
    expect(railArrows({ scrollLeft: 940, clientWidth: 360, scrollWidth: 1300 })).toEqual({ overflow: true, canPrev: true, canNext: false });
  });

  it("enables both arrows in the middle", () => {
    expect(railArrows({ scrollLeft: 400, clientWidth: 360, scrollWidth: 1300 })).toEqual({ overflow: true, canPrev: true, canNext: true });
  });

  it("counts a position within 2 px of an edge as that edge, as browsers round scroll positions", () => {
    expect(railArrows({ scrollLeft: 1.5, clientWidth: 360, scrollWidth: 1300 }).canPrev).toBe(false);
    expect(railArrows({ scrollLeft: 938.4, clientWidth: 360, scrollWidth: 1300 }).canNext).toBe(false);
  });

  it("reads a right-to-left negative scroll position", () => {
    expect(railArrows({ scrollLeft: -940, clientWidth: 360, scrollWidth: 1300 })).toEqual({ overflow: true, canPrev: true, canNext: false });
  });

  it("hides the arrows for a track that is not laid out yet", () => {
    expect(railArrows({ scrollLeft: 0, clientWidth: 0, scrollWidth: 0 })).toEqual(NO_OVERFLOW);
    expect(railArrows({ scrollLeft: Number.NaN, clientWidth: 360, scrollWidth: 1300 })).toEqual(NO_OVERFLOW);
  });

  it("moves most of a visible width for each press, and never zero", () => {
    expect(railStep(360)).toBe(306);
    expect(railStep(0)).toBe(1);
  });

  it("compares arrow states by value, so the rail does not re-render on each scroll event", () => {
    expect(sameArrows({ overflow: true, canPrev: true, canNext: false }, { overflow: true, canPrev: true, canNext: false })).toBe(true);
    expect(sameArrows(NO_OVERFLOW, { overflow: true, canPrev: false, canNext: true })).toBe(false);
  });
});
