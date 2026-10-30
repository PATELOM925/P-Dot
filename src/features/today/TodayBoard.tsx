"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { TODAY_SECTIONS, type TodaySectionId } from "./layout";
import { useArranging, useTodayLayout } from "./layout-store";
import { TodaySectionContext } from "./TodaySection";

export interface BoardSection {
  id: TodaySectionId;
  title: string;
  node: ReactNode;
}

const isSectionId = (value: string): value is TodaySectionId => (TODAY_SECTIONS as readonly string[]).includes(value);

/** The section that holds the element with this ID, such as "tasks" for #tasks. */
function sectionOf(elementId: string): TodaySectionId | null {
  const element = document.getElementById(elementId);
  const slot = element?.closest<HTMLElement>("[data-today-section]");
  const id = slot?.dataset.todaySection ?? "";
  return isSectionId(id) ? id : null;
}

/**
 * The Today sections in the user's order. Each one can collapse; in Arrange
 * mode each one can move up or down. A link to an anchor in a collapsed
 * section (such as #tasks) opens that section.
 */
export function TodayBoard({ userId, sections }: { userId: string; sections: BoardSection[] }) {
  const [layout, dispatch] = useTodayLayout(userId);
  const [arranging, setArranging] = useArranging();
  const [announcement, setAnnouncement] = useState("");
  const pendingFocus = useRef<{ id: TodaySectionId; by: -1 | 1 } | null>(null);
  const byId = new Map(sections.map((section) => [section.id, section]));
  const order = layout.order.filter((id) => byId.has(id));

  useEffect(() => () => setArranging(false), [setArranging]);

  useEffect(() => {
    const open = (hash: string) => {
      // Section ids are plain ASCII, so the hash is not decoded: a bad escape such as "#%" must not throw.
      const target = hash.replace(/^#/, "");
      const id = target ? sectionOf(target) : null;
      if (id) dispatch({ type: "expand", id });
    };
    open(window.location.hash);
    const onHash = () => open(window.location.hash);
    // Next.js links change the hash with pushState, which fires no hashchange event.
    const onClick = (event: MouseEvent) => {
      const link = (event.target as Element | null)?.closest?.("a[href^='#']");
      if (link) open(link.getAttribute("href") ?? "");
    };
    window.addEventListener("hashchange", onHash);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("hashchange", onHash);
      document.removeEventListener("click", onClick, true);
    };
  }, [dispatch]);

  // Moving a section moves its DOM node, which can drop focus. Put it back on the same button,
  // or on the other one when the section reached the end.
  useLayoutEffect(() => {
    const pending = pendingFocus.current;
    if (!pending) return;
    pendingFocus.current = null;
    const button = (by: -1 | 1) => document.querySelector<HTMLButtonElement>(`[data-move="${pending.id}:${by === -1 ? "up" : "down"}"]`);
    const same = button(pending.by);
    (same?.getAttribute("aria-disabled") === "true" ? button(pending.by === -1 ? 1 : -1) : same)?.focus();
  });

  return (
    <>
      <p className="visually-hidden" aria-live="polite">
        {announcement}
      </p>
      <div className={`today-board${arranging ? " is-arranging" : ""}`}>
        {order.map((id, position) => {
          const section = byId.get(id)!;
          return (
            <TodaySectionContext.Provider
              key={id}
              value={{
                id,
                title: section.title,
                bodyId: `today-${id}-body`,
                collapsed: layout.collapsed.includes(id),
                arranging,
                position,
                count: order.length,
                toggle: () => dispatch({ type: "toggle", id }),
                move: (by) => {
                  pendingFocus.current = { id, by };
                  dispatch({ type: "move", id, by });
                  setAnnouncement(`${section.title} moved to position ${position + by + 1} of ${order.length}.`);
                },
              }}
            >
              <div className="today-slot" data-today-section={id}>
                {section.node}
              </div>
            </TodaySectionContext.Provider>
          );
        })}
      </div>
    </>
  );
}
