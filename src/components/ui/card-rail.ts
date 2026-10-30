// Arrow state for CardRail. Pure, so it is unit-tested without a browser.

export interface RailMetrics {
  scrollLeft: number;
  clientWidth: number;
  scrollWidth: number;
}

export interface RailArrows {
  /** False when every card fits: the arrows are hidden. */
  overflow: boolean;
  canPrev: boolean;
  canNext: boolean;
}

export const NO_OVERFLOW: RailArrows = { overflow: false, canPrev: false, canNext: false };

/** Browsers round scroll positions to fractions of a pixel, so an edge counts within this distance. */
const EDGE_PX = 2;

export function railArrows({ scrollLeft, clientWidth, scrollWidth }: RailMetrics): RailArrows {
  const max = scrollWidth - clientWidth;
  if (!Number.isFinite(max) || !Number.isFinite(scrollLeft) || max <= EDGE_PX) return NO_OVERFLOW;
  // A right-to-left page reports a negative scrollLeft.
  const offset = Math.abs(scrollLeft);
  return { overflow: true, canPrev: offset > EDGE_PX, canNext: offset < max - EDGE_PX };
}

export function sameArrows(a: RailArrows, b: RailArrows): boolean {
  return a.overflow === b.overflow && a.canPrev === b.canPrev && a.canNext === b.canNext;
}

/** One arrow press moves most of a visible width; scroll snap then lines up the next card. */
export function railStep(clientWidth: number): number {
  return Math.max(Math.round(clientWidth * 0.85), 1);
}
