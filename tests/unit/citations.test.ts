import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AssistantReply } from "@/features/chat/AssistantReply";
import { parseInline, parseMarkdown } from "@/features/chat/markdown/parse";
import { planReply } from "@/features/chat/markdown/plan";
import type { SourceRef } from "@/types/api";

const SOURCES: SourceRef[] = [
  { title: "25 Best Bars in Toronto", url: "https://www.blogto.com/bars" },
  { title: "Fairmont Royal York: dining", url: "https://www.fairmont.com/toronto" },
];

const render = (text: string, sources: SourceRef[] = SOURCES, showSources = true) =>
  renderToStaticMarkup(createElement(AssistantReply, { text, sources, messageId: "m1", showSources }));

describe("citation chips", () => {
  it("parses [n] as a citation, and [text](url) as a link", () => {
    expect(parseInline("A bar [1][2].")).toEqual([
      { type: "text", text: "A bar " },
      { type: "cite", n: 1 },
      { type: "cite", n: 2 },
      { type: "text", text: "." },
    ]);
    expect(parseInline("[1](https://a.com)")[0]).toMatchObject({ type: "link" });
  });

  it("parses the forms a reply saved before the server fix can hold as citations", () => {
    expect(parseInline("A 【2†L1-L4】 B 【1】 C [2†source].")).toEqual([
      { type: "text", text: "A " },
      { type: "cite", n: 2 },
      { type: "text", text: " B " },
      { type: "cite", n: 1 },
      { type: "text", text: " C " },
      { type: "cite", n: 2 },
      { type: "text", text: "." },
    ]);
    expect(render("Union Cafe 【2†L1-L4】.")).toContain('href="#src-m1-2"');
  });

  it("renders [1] as a chip linked to the source line, with the host in the tooltip", () => {
    const out = render("Hidden rooms [1].");
    expect(out).toContain('href="#src-m1-1"');
    expect(out).toContain('class="cite"');
    expect(out).toContain('aria-label="Source 1, blogto.com"');
    expect(out).toContain("cite-tip-host");
    expect(out).toContain('id="src-m1-1"');
  });

  it("renders a number with no source as muted text, never a link", () => {
    const out = render("See [3].");
    expect(out).toContain('class="cite-missing"');
    expect(out).not.toContain('href="#src-m1-3"');
  });

  it("renders [1][2] as two chips", () => {
    expect(render("Both [1][2].").match(/class="cite"/g)).toHaveLength(2);
  });

  it("shows no chips when the reply has no web sources", () => {
    expect(render("Old mark [1].", SOURCES, false)).not.toContain('class="cite"');
  });

  it("keeps the number of a source with an unsafe link, so the next chip still points to the right line", () => {
    const sources = [
      { title: "Bad", url: "javascript:alert(1)" },
      { title: "Good", url: "https://good.example/page" },
    ];
    const out = render("Good place [2].", sources);
    expect(out).toContain('href="#src-m1-2"');
    expect(out).toContain('aria-label="Source 2, good.example"');
    expect(out).toContain('id="src-m1-1"');
    expect(out).toContain("Link removed");
    expect(out).not.toContain("javascript:");
  });

  it("counts cited sources, and the row says so", () => {
    expect([...planReply(parseMarkdown("a [1] b **[1]** c [5] [2](https://x.example)"), 2, false).cited]).toEqual([1]);
    const out = render("Hidden rooms [1].");
    expect(out).toContain("2 sources · 1 cited · blogto.com, fairmont.com");
    expect(out).toContain("P-Dot used these pages as context. They do not prove the answer.");
    expect(out).toContain("not cited");
    expect(render("No marks.")).toContain("none cited");
  });

  it("counts citations inside cards, and in the text, but not in a card that is not shown", () => {
    const places = { items: [{ name: "Library Bar", cite: [1, 2] }] };
    const text = "Bars:\n\n```pdot-places\n" + JSON.stringify(places) + "\n```\n";
    expect([...planReply(parseMarkdown(text), 2, false).cited].sort()).toEqual([1, 2]);
    expect(render(text)).toContain("2 sources · 2 cited");
    // While the card streams, its citations are not counted yet.
    expect(planReply(parseMarkdown(text.slice(0, -5)), 2, true).cited.size).toBe(0);
    // A fourth card is not shown, so its citations do not count.
    const checklist = "```pdot-checklist\n" + JSON.stringify({ items: [{ text: "x" }] }) + "\n```\n";
    const steps = "```pdot-steps\n" + JSON.stringify({ items: [{ title: "a", cite: [2] }, { title: "b" }] }) + "\n```\n";
    expect([...planReply(parseMarkdown(checklist.repeat(3) + steps), 2, false).cited]).toEqual([]);
  });

  it("puts cited sources first in the list", () => {
    const out = render("Hotel bar [2].");
    expect(out.indexOf('id="src-m1-2"')).toBeLessThan(out.indexOf('id="src-m1-1"'));
  });
});
