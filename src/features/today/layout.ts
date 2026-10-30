// The order of the Today sections and which are collapsed, kept per user on
// this device. Pure, so it is unit-tested; layout-store.ts keeps it in storage.

export const TODAY_SECTIONS = ["up-next", "recent-chats", "brief", "approvals", "tasks", "workflows"] as const;

export type TodaySectionId = (typeof TODAY_SECTIONS)[number];

export interface TodayLayout {
  order: TodaySectionId[];
  collapsed: TodaySectionId[];
}

export type LayoutAction =
  | { type: "move"; id: TodaySectionId; by: -1 | 1 }
  | { type: "toggle"; id: TodaySectionId }
  | { type: "expand"; id: TodaySectionId }
  | { type: "reset" };

export const DEFAULT_LAYOUT: TodayLayout = { order: [...TODAY_SECTIONS], collapsed: [] };

export const layoutKey = (userId: string) => `pdot.today.layout.${userId}`;

const isSectionId = (value: unknown): value is TodaySectionId =>
  typeof value === "string" && (TODAY_SECTIONS as readonly string[]).includes(value);

/** Known IDs once each, in the given order. */
function known(values: unknown): TodaySectionId[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.filter(isSectionId))];
}

/**
 * Reads a stored layout. Unknown or removed sections are dropped. A section
 * that the stored order does not have (a new one) goes back in after the
 * section it follows in the default order. Anything unreadable is the default.
 */
export function parseLayout(raw: string | null): TodayLayout {
  if (!raw) return DEFAULT_LAYOUT;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return DEFAULT_LAYOUT;
  }
  if (typeof value !== "object" || value === null) return DEFAULT_LAYOUT;
  const stored = value as { order?: unknown; collapsed?: unknown };
  const order = known(stored.order);
  TODAY_SECTIONS.forEach((id, index) => {
    if (order.includes(id)) return;
    const before = TODAY_SECTIONS.slice(0, index).findLast((earlier) => order.includes(earlier));
    order.splice(before ? order.indexOf(before) + 1 : 0, 0, id);
  });
  return { order, collapsed: known(stored.collapsed) };
}

export function serializeLayout(layout: TodayLayout): string {
  return JSON.stringify({ order: layout.order, collapsed: layout.collapsed });
}

export function layoutReducer(layout: TodayLayout, action: LayoutAction): TodayLayout {
  switch (action.type) {
    case "move": {
      const from = layout.order.indexOf(action.id);
      const to = from + action.by;
      if (from < 0 || to < 0 || to >= layout.order.length) return layout;
      const order = [...layout.order];
      [order[from], order[to]] = [order[to]!, order[from]!];
      return { ...layout, order };
    }
    case "toggle":
      return {
        ...layout,
        collapsed: layout.collapsed.includes(action.id)
          ? layout.collapsed.filter((id) => id !== action.id)
          : [...layout.collapsed, action.id],
      };
    case "expand":
      return layout.collapsed.includes(action.id)
        ? { ...layout, collapsed: layout.collapsed.filter((id) => id !== action.id) }
        : layout;
    case "reset":
      return DEFAULT_LAYOUT;
  }
}
