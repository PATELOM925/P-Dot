"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { NO_OVERFLOW, railArrows, railStep, sameArrows } from "./card-rail";

interface CardRailProps {
  title: string;
  level?: 2 | 3;
  /** Shown between the header and the cards, such as a notice. */
  intro?: ReactNode;
  children: ReactNode;
}

const ARROW_PATHS = { prev: "M15 18l-6-6 6-6", next: "M9 18l6-6-6-6" };

/**
 * One row of cards that scrolls sideways with native scrolling and scroll
 * snap, so touch, trackpad and keyboard all work. The Previous and Next
 * buttons are in the header; they are hidden when every card fits.
 */
export function CardRail({ title, level = 2, intro, children }: CardRailProps) {
  const headingId = useId();
  const trackId = useId();
  const trackRef = useRef<HTMLDivElement>(null);
  const [arrows, setArrows] = useState(NO_OVERFLOW);
  const Heading = level === 3 ? "h3" : "h2";

  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const next = railArrows(track);
        setArrows((current) => (sameArrows(current, next) ? current : next));
      });
    };
    measure();
    track.addEventListener("scroll", measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(track);
    for (const card of Array.from(track.children)) observer.observe(card);
    return () => {
      cancelAnimationFrame(frame);
      track.removeEventListener("scroll", measure);
      observer.disconnect();
    };
  }, []);

  function move(direction: -1 | 1) {
    const track = trackRef.current;
    if (!track) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    track.scrollBy({ left: direction * railStep(track.clientWidth), behavior: reduce ? "auto" : "smooth" });
  }

  const arrow = (kind: "prev" | "next", enabled: boolean) => (
    <button
      type="button"
      className="icon-button card-rail-arrow"
      aria-label={`${kind === "prev" ? "Previous" : "Next"} cards in ${title}`}
      aria-controls={trackId}
      // aria-disabled keeps the button focusable at the end of the row, so keyboard focus does not jump away.
      aria-disabled={!enabled}
      onClick={() => enabled && move(kind === "prev" ? -1 : 1)}
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d={ARROW_PATHS[kind]} />
      </svg>
    </button>
  );

  return (
    <div className="card-rail">
      <div className="card-rail-head">
        <Heading id={headingId}>{title}</Heading>
        <div className="card-rail-arrows" hidden={!arrows.overflow}>
          {arrow("prev", arrows.canPrev)}
          {arrow("next", arrows.canNext)}
        </div>
      </div>
      {intro}
      <div ref={trackRef} id={trackId} className="card-rail-track" role="region" aria-labelledby={headingId} tabIndex={0}>
        {children}
      </div>
    </div>
  );
}
