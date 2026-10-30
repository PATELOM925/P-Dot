import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AssistantReply } from "@/features/chat/AssistantReply";
import { mapsSearchUrl } from "@/lib/maps-url";
import { MAX_RICH_BLOCK_CHARS, parseRichBlock, richBlockKind } from "@/lib/rich-blocks";
import type { SourceRef } from "@/types/api";

const SOURCES: SourceRef[] = [
  { title: "25 Best Bars in Toronto", url: "https://www.blogto.com/bars" },
  { title: "Fairmont Royal York: dining", url: "https://www.fairmont.com/toronto" },
];

const PLACES = {
  title: "Bars in Toronto",
  items: [
    { name: "Walrus Pub & Beer Hall", kind: "Pub", area: "Financial District", city: "Toronto", note: "Ping pong downstairs.", cite: [1] },
    { name: "Library Bar", kind: "Hotel bar", area: "Fairmont Royal York", city: "Toronto", cite: [2, 9] },
  ],
};

const fence = (info: string, body: unknown) => `Here you go.\n\n\`\`\`${info}\n${typeof body === "string" ? body : JSON.stringify(body)}\n\`\`\`\n`;
const render = (text: string, streaming = false) =>
  renderToStaticMarkup(createElement(AssistantReply, { text, sources: SOURCES, messageId: "m1", showSources: true, streaming }));

describe("parseRichBlock", () => {
  it("accepts a valid block of each kind", () => {
    expect(parseRichBlock("places", JSON.stringify(PLACES), 2)?.kind).toBe("places");
    expect(
      parseRichBlock("table", JSON.stringify({ columns: ["Bar", "Area"], rows: [{ cells: ["Walrus", "Financial District"] }] }), 2)
        ?.kind,
    ).toBe("table");
    expect(parseRichBlock("checklist", JSON.stringify({ items: [{ text: "Passport", done: true }] }), 0)?.kind).toBe("checklist");
    expect(parseRichBlock("steps", JSON.stringify({ items: [{ title: "Book" }, { title: "Pack", when: "Day 1" }] }), 0)?.kind).toBe(
      "steps",
    );
  });

  it("refuses unknown keys, URLs, too many items, wrong row length, bad JSON and long bodies", () => {
    expect(parseRichBlock("places", JSON.stringify({ items: [{ name: "A", url: "https://evil.example" }] }), 2)).toBeNull();
    expect(parseRichBlock("places", JSON.stringify({ items: Array.from({ length: 9 }, (_, k) => ({ name: `P${k}` })) }), 2)).toBeNull();
    expect(parseRichBlock("table", JSON.stringify({ columns: ["A", "B"], rows: [{ cells: ["1"] }] }), 2)).toBeNull();
    expect(parseRichBlock("places", "{items: [}", 2)).toBeNull();
    expect(parseRichBlock("places", " ".repeat(MAX_RICH_BLOCK_CHARS + 1), 2)).toBeNull();
  });

  it("removes citations above the source count", () => {
    const block = parseRichBlock("places", JSON.stringify(PLACES), 2);
    expect(block?.kind === "places" && block.data.items[1]?.cite).toEqual([2]);
  });

  it("reads pdot-places, pdot:places and pdot places", () => {
    expect(["pdot-places", "pdot:places", "pdot places", "PDOT-Places"].map(richBlockKind)).toEqual(["places", "places", "places", "places"]);
    expect(richBlockKind("pdot-map")).toBeNull();
    expect(richBlockKind("js")).toBeNull();
  });
});

describe("mapsSearchUrl", () => {
  it("builds a Google Maps search link from the name, area and city", () => {
    expect(mapsSearchUrl({ name: "Library Bar", area: "Fairmont Royal York", city: "Toronto" })).toBe(
      "https://www.google.com/maps/search/?api=1&query=Library%20Bar%2C%20Fairmont%20Royal%20York%2C%20Toronto",
    );
  });

  it("encodes &, #, ? and accents, and leaves out empty parts", () => {
    const url = mapsSearchUrl({ name: "Café & Bar #1?", area: " " })!;
    expect(url.startsWith("https://www.google.com/maps/search/?api=1&query=")).toBe(true);
    expect(url).toContain("Caf%C3%A9%20%26%20Bar%20%231%3F");
    expect(url).not.toContain("%2C");
  });

  it("returns null for a link that would be too long", () => {
    expect(mapsSearchUrl({ name: "x".repeat(3000) })).toBeNull();
  });
});

describe("rich block rendering", () => {
  it("renders places with Maps links that P-Dot builds and citation chips", () => {
    const out = render(fence("pdot-places", PLACES));
    expect(out).toContain("Walrus Pub &amp; Beer Hall");
    expect(out).toContain("https://www.google.com/maps/search/?api=1&amp;query=Walrus%20Pub%20%26%20Beer%20Hall");
    expect(out).toContain("Map links search by name. Check the place before you go.");
    expect(out).toContain('href="#src-m1-2"');
    expect(out).not.toContain("&quot;items&quot;");
  });

  it("shows a failed block as code with one label, so nothing is lost", () => {
    const out = render(fence("pdot-places", '{"items":[{"name":"A","url":"https://evil.example"}]}'));
    expect(out).toContain("P-Dot could not show this as a card.");
    expect(out).toContain("<pre>");
    expect(out).not.toContain('href="https://evil.example');
  });

  it("shows a placeholder, not JSON, while a block streams in", () => {
    const out = render('Here you go.\n\n```pdot-places\n{"title":"Bars","items":[{"na', true);
    expect(out).toContain("Preparing places…");
    expect(out).not.toContain("&quot;title&quot;");
  });

  it("shows an unclosed block of a saved reply as code", () => {
    expect(render('```pdot-places\n{"items":[', false)).toContain("P-Dot could not show this as a card.");
  });

  it("renders at most 3 cards in one reply", () => {
    const one = fence("pdot-checklist", { items: [{ text: "Pack" }] });
    const out = render(one.repeat(4));
    expect(out.match(/class="rich-card"/g)).toHaveLength(3);
    expect(out).toContain("P-Dot could not show this as a card.");
  });

  it("renders table, checklist and steps cards", () => {
    const table = fence("pdot-table", { title: "Compare", columns: ["Bar", "Price"], rows: [{ cells: ["Walrus", 12], cite: [1] }, { cells: ["Clockwork", null] }] });
    const out = render(
      table +
        fence("pdot-checklist", { items: [{ text: "Passport", done: true }, { text: "Charger" }] }) +
        fence("pdot-steps", { items: [{ title: "Land", when: "Day 1" }, { title: "Walk", detail: "Old town" }] }),
    );
    expect(out).toContain("<caption>Compare</caption>");
    expect(out).toContain('aria-label="No data"');
    expect(out).toContain("Done: ");
    expect(out).toContain('class="rich-steps"');
  });
});
