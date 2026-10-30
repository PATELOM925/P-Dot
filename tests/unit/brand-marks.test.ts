import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BrandName } from "@/components/ui/BrandMark";
import { BRAND_COLORS, BRAND_IDS, BRAND_PATHS } from "@/components/ui/brand-marks";
import { googleToolItem } from "@/features/chat/composer-sources";
import { MCP_SERVER_IDS } from "@/lib/connectors";

const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

// The card colour of each theme, read from the stylesheet so a palette change is checked too.
const surfaces = [...readFileSync("src/app/globals.css", "utf8").matchAll(/--surface:\s*(#[0-9a-f]{6});/gi)].map((m) => m[1]!);

describe("brand marks", () => {
  it("has a mark for every app and for each planned service", () => {
    for (const id of [...MCP_SERVER_IDS, "gmail", "googlecalendar", "google", "telegram", "github", "vercel", "whatsapp"]) {
      expect(BRAND_IDS).toContain(id);
    }
    for (const id of BRAND_IDS) expect(BRAND_PATHS[id]).toMatch(/^[Mm][0-9.\s-]/);
  });

  it("is readable on a light and on a dark card (3:1 or more)", () => {
    const [light, dark] = surfaces;
    expect([light, dark]).toEqual(["#ffffff", "#1d1f26"]);
    for (const id of BRAND_IDS) {
      expect(contrast(BRAND_COLORS[id].light, light!), `${id} on light`).toBeGreaterThanOrEqual(3);
      expect(contrast(BRAND_COLORS[id].dark, dark!), `${id} on dark`).toBeGreaterThanOrEqual(3);
    }
  });

  it("is decorative, 20 px, with the name still as text", () => {
    const html = renderToStaticMarkup(createElement(BrandName, { brand: "notion", name: "Notion" }));
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('width="20"');
    expect(html).toMatch(/<\/svg>Notion<\/span>$/);
  });

  it("shows the Google mark on the Google row of the + menu", () => {
    expect(googleToolItem("connected", false)).toMatchObject({ brand: "google" });
  });
});
