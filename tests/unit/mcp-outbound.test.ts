import { describe, expect, it } from "vitest";
import { MCP_SERVERS } from "@/server/mcp/catalog";
import { TurnIds, isUserPhrase, normalizePhrase } from "@/server/mcp/outbound";

const notion = MCP_SERVERS.notion;
const linear = MCP_SERVERS.linear;
const MESSAGE = "Find the project plan and budget for next year";
const PAGE = "1a2b3c4d5e6f70819a0b1c2d3e4f5a6b";
const PAGE_DASHED = "1a2b3c4d-5e6f-7081-9a0b-1c2d3e4f5a6b";

describe("user_phrase", () => {
  it("accepts one contiguous phrase of the user's message, in any case and spacing", () => {
    expect(isUserPhrase("project plan", MESSAGE)).toBe(true);
    expect(isUserPhrase("  PROJECT   Plan ", MESSAGE)).toBe(true);
    expect(isUserPhrase(MESSAGE, MESSAGE)).toBe(true);
  });

  it("refuses the user's words in another order or with words left out", () => {
    expect(isUserPhrase("the budget plan for next year", MESSAGE)).toBe(false);
    expect(isUserPhrase("plan budget", MESSAGE)).toBe(false);
    expect(isUserPhrase("project budget", MESSAGE)).toBe(false);
  });

  it("refuses a phrase that cuts a word, an empty phrase and more than 120 characters", () => {
    expect(isUserPhrase("roject plan", MESSAGE)).toBe(false);
    expect(isUserPhrase("project pla", MESSAGE)).toBe(false);
    expect(isUserPhrase("", MESSAGE)).toBe(false);
    expect(isUserPhrase("   ", MESSAGE)).toBe(false);
    const long = `${"word ".repeat(30)}`.trim();
    expect(isUserPhrase(long.slice(0, 120), long)).toBe(true);
    expect(isUserPhrase(`${long.slice(0, 120)}x`, `${long.slice(0, 120)}x and more`)).toBe(false);
  });

  it("handles multi-byte and compatibility forms", () => {
    expect(isUserPhrase("café menü", "Check the CAFÉ MENÜ for Friday")).toBe(true);
    expect(isUserPhrase("ｐｌａｎ", "the plan")).toBe(true);
    expect(normalizePhrase("Ａ\tB\n c")).toBe("a b c");
    expect(isUserPhrase("日本 旅行", "日本 旅行 の 予定")).toBe(true);
  });

  it("refuses private text that is not in the message, also when it shares its words", () => {
    expect(isUserPhrase("my salary is 90000", "what is my plan")).toBe(false);
  });
});

describe("turn_ids", () => {
  it("accepts an ID from a typed field of this app's result in this turn", () => {
    const ids = new TurnIds("find my notes", [notion, linear]);
    expect(ids.allowed(notion, PAGE)).toBeNull();
    ids.addFromResult(notion, { results: [{ id: PAGE_DASHED, title: "Plan" }] });
    expect(ids.allowed(notion, PAGE)).toBe(PAGE_DASHED);
    expect(ids.allowed(notion, PAGE_DASHED.toUpperCase())).toBe(PAGE_DASHED);
  });

  it("refuses an ID that appears only in result text, not in a typed ID field", () => {
    const ids = new TurnIds("find my notes", [notion]);
    ids.addFromResult(notion, { results: [{ id: PAGE, title: `see ${"0".repeat(32)}` }], note: `other ${"f".repeat(32)}` });
    ids.addFromResult(notion, `text that holds ${"e".repeat(32)}`);
    expect(ids.allowed(notion, "0".repeat(32))).toBeNull();
    expect(ids.allowed(notion, "f".repeat(32))).toBeNull();
    expect(ids.allowed(notion, "e".repeat(32))).toBeNull();
  });

  it("refuses an ID that another app returned", () => {
    const ids = new TurnIds("look at the issues", [notion, linear]);
    ids.addFromResult(linear, { issues: [{ id: "ENG-12" }] });
    expect(ids.allowed(linear, "ENG-12")).toBe("ENG-12");
    expect(ids.allowed(notion, "ENG-12")).toBeNull();
    ids.addFromResult(notion, { results: [{ id: PAGE }] });
    expect(ids.allowed(linear, PAGE)).toBeNull();
  });

  it("accepts IDs that the user typed only in the app's format", () => {
    const ids = new TurnIds(`Read https://www.notion.so/Plan-${PAGE} and ENG-7, and my code 12345`, [notion, linear]);
    expect(ids.allowed(notion, PAGE)).toBe(PAGE_DASHED);
    expect(ids.allowed(linear, "ENG-7")).toBe("ENG-7");
    expect(ids.allowed(linear, "12345")).toBeNull();
    expect(ids.allowed(notion, "12345")).toBeNull();
  });

  it("collects nothing from a result whose shape is unknown (fail closed)", () => {
    const ids = new TurnIds("x", [notion]);
    ids.addFromResult(notion, { pages: [{ id: PAGE }] });
    ids.addFromResult(notion, null);
    expect(ids.allowed(notion, PAGE)).toBeNull();
  });
});
