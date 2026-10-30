import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config";

describe("old page addresses", () => {
  it("send /action-log to /activity and /workflows to the Workflows section of Today, permanently", async () => {
    const redirects = await nextConfig.redirects!();
    expect(redirects).toEqual(
      expect.arrayContaining([
        { source: "/action-log", destination: "/activity", permanent: true },
        { source: "/workflows", destination: "/today#workflows", permanent: true },
      ]),
    );
  });

  it("have no page of their own, and the nav links only to the new pages", () => {
    expect(existsSync("src/app/(workspace)/action-log/page.tsx")).toBe(false);
    expect(existsSync("src/app/(workspace)/workflows/page.tsx")).toBe(false);
    for (const file of ["src/components/layout/NavLinks.tsx", "src/components/layout/BottomNav.tsx"]) {
      const source = readFileSync(file, "utf8");
      expect(source).not.toContain('"/action-log"');
      expect(source).not.toContain('"/workflows"');
      expect(source).toContain('"/activity"');
    }
  });

  it("put the top nav in the agreed order", () => {
    const source = readFileSync("src/components/layout/NavLinks.tsx", "utf8");
    const labels = [...source.matchAll(/label: "([^"]+)"/g)].map((match) => match[1]);
    expect(labels).toEqual(["Chat", "Today", "Connectors", "Memory", "Activity", "Settings"]);
  });
});
