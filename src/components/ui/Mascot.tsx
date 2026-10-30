import { useId } from "react";

/**
 * P-Dot's friendly face: a round, gradient dot with two eyes and a smile.
 * Decorative (the page already says "P-Dot" in text), so it is hidden from
 * screen readers. The blink and float animations stop for reduced motion.
 */
export function Mascot({ size = 56, float = false, className = "" }: { size?: number; float?: boolean; className?: string }) {
  const id = useId();
  const gradient = `mascot-grad-${id}`;
  return (
    <svg
      className={`mascot${float ? " mascot-float" : ""} ${className}`.trim()}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id={gradient} x1="8" y1="6" x2="56" y2="60" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#6366f1" />
          <stop offset="0.55" stopColor="#8b5cf6" />
          <stop offset="1" stopColor="#ec4899" />
        </linearGradient>
      </defs>
      <circle cx="32" cy="32" r="29" fill={`url(#${gradient})`} />
      <ellipse cx="22" cy="15" rx="11" ry="6" fill="#fff" opacity="0.22" transform="rotate(-24 22 15)" />
      <g className="mascot-eyes" fill="#fff">
        <ellipse cx="23" cy="29" rx="3.6" ry="4.6" />
        <ellipse cx="41" cy="29" rx="3.6" ry="4.6" />
      </g>
      <circle cx="16" cy="39" r="4" fill="#fda4af" opacity="0.7" />
      <circle cx="48" cy="39" r="4" fill="#fda4af" opacity="0.7" />
      <path d="M23 41c2.6 4.6 15.4 4.6 18 0" fill="none" stroke="#fff" strokeWidth="3.2" strokeLinecap="round" />
    </svg>
  );
}
