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

  it("keeps the public controls evidence page public and discoverable", () => {
    const proxy = readFileSync("src/proxy.ts", "utf8");
    const footer = readFileSync("src/components/layout/SiteFooter.tsx", "utf8");
    const page = readFileSync("src/app/controls/page.tsx", "utf8");
    expect(proxy).toContain("controls$");
    expect(footer).toContain('href="/controls"');
    expect(page).toContain("Selected-controls evidence map");
    expect(page).toContain("AGSC");
    for (const id of ["ALN-02", "SEC-02", "SEC-03", "SEC-04", "SEC-07", "SAF-02"]) {
      expect(page).toContain(`id: "${id}"`);
    }
    expect(page).toContain("COHUMAIN-LABS/AGSC-agentic-controls-by-SafeAlignAI");
  });
});
