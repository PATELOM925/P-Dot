import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("connector capability disclosure", () => {
  it("renders the current Google and MCP tool descriptions from their server policy", () => {
    const source = readFileSync("src/app/(workspace)/connectors/page.tsx", "utf8");
    expect(source).toContain("MCP_SERVERS");
    expect(source).toContain("server.tools.map((tool) => tool.description)");
    expect(source).toContain("GOOGLE_TOOLS.map((tool) => tool.description)");
    expect(source).toContain("are read-only");
    expect(source).toContain("only after you approve");
  });
});
