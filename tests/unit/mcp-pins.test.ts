import { describe, expect, it } from "vitest";
import { MCP_SERVERS } from "@/server/mcp/catalog";
import { canonicalJson, isCompatible, pinOf, pinTools } from "@/server/mcp/pins";
import { NOTION_TOOLS } from "../support/fake-mcp";

const fetchTool = MCP_SERVERS.notion.tools.find((tool) => tool.name === "notion_fetch")!;

describe("tool pins", () => {
  it("gives the same pin when only the key order changes", async () => {
    const a = { name: "t", inputSchema: { type: "object", properties: { a: { type: "string" }, b: { type: "number" } } } };
    const b = { inputSchema: { properties: { b: { type: "number" }, a: { type: "string" } }, type: "object" }, name: "t" };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(await pinOf(a)).toBe(await pinOf(b));
    expect(await pinOf(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("gives another pin for a changed description, enum, name or required list", async () => {
    const base = NOTION_TOOLS[0]!;
    const pin = await pinOf(base);
    const changed = structuredClone(base);
    (changed.inputSchema.properties as Record<string, { description?: string }>).query!.description = "new text";
    expect(await pinOf(changed)).not.toBe(pin);
    expect(await pinOf({ ...base, name: "notion-search-2" })).not.toBe(pin);
    expect(await pinOf({ ...base, inputSchema: { ...base.inputSchema, required: [] } })).not.toBe(pin);
  });

  it("pins only catalog tools that take every argument P-Dot sends and need no other", async () => {
    const pins = await pinTools(MCP_SERVERS.notion, NOTION_TOOLS);
    expect(Object.keys(pins).sort()).toEqual(["notion-fetch", "notion-search"]);
    expect(isCompatible({ name: "notion-fetch", inputSchema: { type: "object", properties: { url: {} } } }, fetchTool)).toBe(false);
    expect(
      isCompatible({ name: "notion-fetch", inputSchema: { type: "object", properties: { id: {}, mode: {} }, required: ["id", "mode"] } }, fetchTool),
    ).toBe(false);
    expect(isCompatible({ name: "notion-fetch", inputSchema: null }, fetchTool)).toBe(false);
    expect(await pinTools(MCP_SERVERS.notion, [])).toEqual({});
  });
});
