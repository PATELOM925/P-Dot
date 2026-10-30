import { describe, expect, it } from "vitest";
import { MAX_PINS, orderByPins, parsePins, togglePin } from "@/features/chat/sidebar-prefs";

const list = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];

describe("pinned conversations", () => {
  it("puts pinned ones first, newest pin at the top, and keeps the rest in order", () => {
    expect(orderByPins(list, ["c", "a"]).map((c) => c.id)).toEqual(["c", "a", "b", "d"]);
    expect(orderByPins(list, []).map((c) => c.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("ignores a pin for a conversation that is not in the list", () => {
    expect(orderByPins(list, ["gone", "b"]).map((c) => c.id)).toEqual(["b", "a", "c", "d"]);
  });

  it("toggles a pin on and off, and keeps at most the limit", () => {
    expect(togglePin(["a"], "b")).toEqual(["b", "a"]);
    expect(togglePin(["b", "a"], "b")).toEqual(["a"]);
    const many = Array.from({ length: MAX_PINS }, (_, i) => `id${i}`);
    const next = togglePin(many, "new");
    expect(next).toHaveLength(MAX_PINS);
    expect(next[0]).toBe("new");
  });

  it("reads bad stored values as no pins", () => {
    expect(parsePins(null)).toEqual([]);
    expect(parsePins("not json")).toEqual([]);
    expect(parsePins('{"a":1}')).toEqual([]);
    expect(parsePins('["a", 2, null, "b"]')).toEqual(["a", "b"]);
  });
});
