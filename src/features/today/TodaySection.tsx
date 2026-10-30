"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { TodaySectionId } from "./layout";

export interface TodaySectionState {
  id: TodaySectionId;
  title: string;
  bodyId: string;
  collapsed: boolean;
  arranging: boolean;
  position: number;
  count: number;
  toggle: () => void;
  move: (by: -1 | 1) => void;
}

export const TodaySectionContext = createContext<TodaySectionState | null>(null);

const ICONS = {
  up: "M18 15l-6-6-6 6",
  down: "M6 9l6 6 6-6",
};

function Icon({ path }: { path: string }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={path} />
    </svg>
  );
}

/**
 * The buttons in a Today section header: show or hide the section, and in
 * Arrange mode, move it up or down. Outside the Today board it shows nothing.
 */
export function SectionControls() {
  const section = useContext(TodaySectionContext);
  if (!section) return null;
  const { id, title, bodyId, collapsed, arranging, position, count } = section;
  const moveButton = (by: -1 | 1) => {
    const enabled = by === -1 ? position > 0 : position < count - 1;
    return (
      <button
        type="button"
        className="icon-button section-control"
        aria-label={`Move ${title} ${by === -1 ? "up" : "down"}`}
        aria-disabled={!enabled}
        data-move={`${id}:${by === -1 ? "up" : "down"}`}
        onClick={() => enabled && section.move(by)}
      >
        <Icon path={by === -1 ? ICONS.up : ICONS.down} />
      </button>
    );
  };
  return (
    <div className="section-controls">
      {arranging && (
        <>
          {moveButton(-1)}
          {moveButton(1)}
        </>
      )}
      <button
        type="button"
        className="icon-button section-control section-toggle"
        aria-label={title}
        aria-expanded={!collapsed}
        aria-controls={bodyId}
        onClick={section.toggle}
      >
        <Icon path={ICONS.down} />
      </button>
    </div>
  );
}

/** The part of a Today section that collapses. Outside the Today board it is a plain wrapper. */
export function SectionBody({ children }: { children: ReactNode }) {
  const section = useContext(TodaySectionContext);
  if (!section) return <>{children}</>;
  return (
    <div id={section.bodyId} className="section-body" hidden={section.collapsed}>
      {children}
    </div>
  );
}
