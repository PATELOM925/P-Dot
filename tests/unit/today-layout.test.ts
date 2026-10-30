import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TodayBoard } from "@/features/today/TodayBoard";
import { SectionBody } from "@/features/today/TodaySection";
import { DEFAULT_LAYOUT, TODAY_SECTIONS, layoutKey, layoutReducer, parseLayout, serializeLayout, type TodayLayout } from "@/features/today/layout";

const layout = (order: TodayLayout["order"], collapsed: TodayLayout["collapsed"] = []): TodayLayout => ({ order, collapsed });

describe("Today layout reducer", () => {
  it("starts in the default order with every section open", () => {
    expect(DEFAULT_LAYOUT).toEqual({
      order: ["up-next", "recent-chats", "brief", "approvals", "tasks", "workflows"],
      collapsed: [],
    });
  });

  it("moves a section up or down by one place", () => {
    const down = layoutReducer(DEFAULT_LAYOUT, { type: "move", id: "up-next", by: 1 });
    expect(down.order).toEqual(["recent-chats", "up-next", "brief", "approvals", "tasks", "workflows"]);
    const up = layoutReducer(down, { type: "move", id: "workflows", by: -1 });
    expect(up.order).toEqual(["recent-chats", "up-next", "brief", "approvals", "workflows", "tasks"]);
    expect(DEFAULT_LAYOUT.order[0]).toBe("up-next");
  });

  it("does not move past either end", () => {
    expect(layoutReducer(DEFAULT_LAYOUT, { type: "move", id: "up-next", by: -1 })).toBe(DEFAULT_LAYOUT);
    expect(layoutReducer(DEFAULT_LAYOUT, { type: "move", id: "workflows", by: 1 })).toBe(DEFAULT_LAYOUT);
  });

  it("collapses and expands a section and keeps its place", () => {
    const collapsed = layoutReducer(DEFAULT_LAYOUT, { type: "toggle", id: "brief" });
    expect(collapsed).toEqual(layout([...TODAY_SECTIONS], ["brief"]));
    expect(layoutReducer(collapsed, { type: "toggle", id: "brief" }).collapsed).toEqual([]);
  });

  it("expands only a collapsed section, and changes nothing for an open one", () => {
    const collapsed = layout([...TODAY_SECTIONS], ["tasks", "brief"]);
    expect(layoutReducer(collapsed, { type: "expand", id: "tasks" }).collapsed).toEqual(["brief"]);
    expect(layoutReducer(DEFAULT_LAYOUT, { type: "expand", id: "tasks" })).toBe(DEFAULT_LAYOUT);
  });

  it("resets to the default order with every section open", () => {
    const changed = layout(["workflows", "tasks", "approvals", "brief", "recent-chats", "up-next"], ["tasks"]);
    expect(layoutReducer(changed, { type: "reset" })).toEqual(DEFAULT_LAYOUT);
  });
});

describe("stored Today layout", () => {
  it("keeps one key for each user", () => {
    expect(layoutKey("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).toBe("pdot.today.layout.aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  });

  it("reads back what it writes", () => {
    const changed = layout(["tasks", "up-next", "recent-chats", "brief", "approvals", "workflows"], ["brief"]);
    expect(parseLayout(serializeLayout(changed))).toEqual(changed);
  });

  it("uses the default for nothing stored and for anything unreadable", () => {
    for (const raw of [null, "", "not json", "null", "42", '"tasks"', "[]"]) {
      expect(parseLayout(raw)).toEqual(DEFAULT_LAYOUT);
    }
    expect(parseLayout('{"order":"tasks","collapsed":{}}')).toEqual(DEFAULT_LAYOUT);
  });

  it("drops unknown and removed sections, and repeats", () => {
    const raw = JSON.stringify({
      order: ["workflows", "calendar", "tasks", "tasks", 7, null, "up-next", "recent-chats", "brief", "approvals"],
      collapsed: ["calendar", "tasks", "tasks", { id: "brief" }],
    });
    expect(parseLayout(raw)).toEqual(layout(["workflows", "tasks", "up-next", "recent-chats", "brief", "approvals"], ["tasks"]));
  });

  it("puts a section the stored order does not have after the section it follows by default", () => {
    // Stored before "approvals" existed, and with "brief" moved to the top.
    const raw = JSON.stringify({ order: ["brief", "up-next", "recent-chats", "tasks", "workflows"], collapsed: [] });
    expect(parseLayout(raw).order).toEqual(["brief", "approvals", "up-next", "recent-chats", "tasks", "workflows"]);
    // With nothing before it in the default order, it goes first.
    expect(parseLayout(JSON.stringify({ order: ["tasks"], collapsed: [] })).order).toEqual([
      "up-next",
      "recent-chats",
      "brief",
      "approvals",
      "tasks",
      "workflows",
    ]);
  });
});

describe("Today board on the server", () => {
  it("renders the default order with every section open, so hydration matches before the stored layout loads", () => {
    const sections = [...TODAY_SECTIONS].reverse().map((id) => ({ id, title: id, node: createElement(SectionBody, null, createElement("p", null, `section ${id}`)) }));
    const html = renderToStaticMarkup(createElement(TodayBoard, { userId: "u1", sections }));
    const positions = TODAY_SECTIONS.map((id) => html.indexOf(`section ${id}`));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(html).toContain('id="today-tasks-body"');
    expect(html).not.toMatch(/\shidden(=|\s|>)/);
  });
});
