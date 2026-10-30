import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Claims that were false on production. Each file must not make them again.
const CHECKS: Array<[file: string, banned: RegExp[]]> = [
  ["src/app/page.tsx", [/laptop and phone/i, /hold the keys/i, /on your own account/i, /GitHub/, /Telegram/]],
  ["src/app/(workspace)/today/page.tsx", [/connectors are not available/i, /planned connectors/i]],
  ["src/features/landing/DynamicAgentCard.tsx", [/connectors are not available/i]],
];

describe("live copy", () => {
  it.each(CHECKS)("%s makes no false claim", (file, banned) => {
    const source = readFileSync(file, "utf8");
    for (const pattern of banned) expect(source).not.toMatch(pattern);
  });

  it("the landing page links to Privacy and Terms", () => {
    const footer = readFileSync("src/components/layout/SiteFooter.tsx", "utf8");
    expect(footer).toContain('href="/privacy"');
    expect(footer).toContain('href="/terms"');
    expect(readFileSync("src/app/page.tsx", "utf8")).toContain("<SiteFooter />");
  });
});
