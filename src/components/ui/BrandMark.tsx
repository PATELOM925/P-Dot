import type { CSSProperties } from "react";
import { BRAND_COLORS, BRAND_PATHS, type BrandId } from "./brand-marks";

/**
 * A service's brand mark, next to its name. Decorative: the name stays as
 * visible text, so screen readers skip the mark.
 */
export function BrandMark({ brand, size = 20 }: { brand: BrandId; size?: number }) {
  const colors = BRAND_COLORS[brand];
  const style = { "--mark-light": colors.light, "--mark-dark": colors.dark } as CSSProperties;
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="0 0 24 24" fill="currentColor" style={style} aria-hidden="true" focusable="false">
      <path d={BRAND_PATHS[brand]} />
    </svg>
  );
}

/** A service name with its brand mark, in place of a text-only pill. */
export function BrandName({ brand, name }: { brand: BrandId; name: string }) {
  return (
    <span className="brand-name">
      <BrandMark brand={brand} />
      {name}
    </span>
  );
}
