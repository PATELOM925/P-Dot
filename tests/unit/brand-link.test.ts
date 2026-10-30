import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BrandLink } from "@/components/layout/BrandLink";

describe("the P-Dot home link", () => {
  it("shows the mascot, hidden from screen readers, so the link's name stays P-Dot", () => {
    const html = renderToStaticMarkup(createElement(BrandLink, { href: "/chat" }));
    expect(html).toMatch(/^<a class="brand" href="\/chat"><svg class="mascot brand-mascot" width="28" height="28"[^>]* aria-hidden="true" focusable="false">/);
    expect(html.replace(/<svg[\s\S]*<\/svg>/, "")).toBe('<a class="brand" href="/chat">P-Dot</a>');
  });
});
