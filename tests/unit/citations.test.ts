import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AssistantReply } from "@/features/chat/AssistantReply";
import { citedNumbers } from "@/features/chat/markdown/cite";
import { parseInline } from "@/features/chat/markdown/parse";
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
    expect([...citedNumbers("a [1] b [1] c [5] [2](x)", 2)]).toEqual([1]);
    const out = render("Hidden rooms [1].");
    expect(out).toContain("2 sources · 1 cited · blogto.com, fairmont.com");
    expect(out).toContain("P-Dot used these pages as context. They do not prove the answer.");
    expect(out).toContain("not cited");
    expect(render("No marks.")).toContain("none cited");
  });

  it("puts cited sources first in the list", () => {
    const out = render("Hotel bar [2].");
    expect(out.indexOf('id="src-m1-2"')).toBeLessThan(out.indexOf('id="src-m1-1"'));
  });
});
