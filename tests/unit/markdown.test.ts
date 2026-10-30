import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "@/features/chat/markdown/Markdown";
import { parseInline, parseMarkdown } from "@/features/chat/markdown/parse";
import { SourceList } from "@/features/chat/MessageView";

const html = (text: string) => renderToStaticMarkup(createElement(Markdown, { text }));

describe("parseMarkdown", () => {
  it("parses paragraphs, headings, lists, code, quotes, tables and rules", () => {
    const blocks = parseMarkdown(
      [
        "# Plan",
        "",
        "Some **bold** and *italic* and `code`.",
        "",
        "- one",
        "- two",
        "  - nested",
        "1. first",
        "2. second",
        "",
        "```ts",
        "const a = 1;",
        "```",
        "> quoted",
        "",
        "| A | B |",
        "| :- | -: |",
        "| 1 | 2 |",
        "",
        "---",
      ].join("\n"),
    );
    expect(blocks.map((b) => b.type)).toEqual(["heading", "paragraph", "list", "list", "code", "quote", "table", "rule"]);
    const list = blocks[2];
    expect(list?.type === "list" && list.items[1]?.children[0]?.type).toBe("list");
    const table = blocks[6];
    expect(table?.type === "table" && table.align).toEqual(["left", "right"]);
  });

  it("keeps an open code fence as code while it streams", () => {
    const blocks = parseMarkdown("Here:\n```py\nprint(1)");
    expect(blocks[1]).toEqual({ type: "code", lang: "py", text: "print(1)", open: true });
  });

  it("does not treat snake_case as emphasis", () => {
    expect(parseInline("use my_var_name here")).toEqual([{ type: "text", text: "use my_var_name here" }]);
  });

  it("reads task list items", () => {
    const [list] = parseMarkdown("- [ ] buy milk\n- [x] pay rent");
    expect(list?.type === "list" && list.items.map((i) => i.task)).toEqual(["open", "done"]);
  });

  it("stays fast on a long reply", () => {
    const text = "Some **bold** text with a [link](https://example.com) and `code`.\n\n".repeat(400);
    const started = performance.now();
    parseMarkdown(text);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe("Markdown rendering", () => {
  it("renders bold, links and headings as elements, with a safe link", () => {
    const out = html("## Title\n\nSee **this** at [example](https://example.com/a).");
    expect(out).toContain('role="heading"');
    expect(out).not.toMatch(/<h[1-6]/);
    expect(out).toContain("<strong>this</strong>");
    expect(out).toContain('href="https://example.com/a"');
    expect(out).toContain('rel="noopener noreferrer nofollow"');
    expect(out).toContain('target="_blank"');
  });

  it("shows an image as its alt text, never as an image", () => {
    const out = html("![a chart](https://example.com/chart.png)");
    expect(out).not.toContain("<img");
    expect(out).toContain("a chart");
  });

  const ATTACKS = [
    "<script>alert(1)</script>",
    "<img src=x onerror=alert(1)>",
    '<iframe src="https://evil.example"></iframe>',
    "[click](javascript:alert(1))",
    "[click](JaVaScRiPt:alert(1))",
    "[click]( javascript:alert(1))",
    "[click](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
    "[click](vbscript:msgbox(1))",
    "[click](https://user:pass@evil.example)",
    "![x](javascript:alert(1))",
    '<a href="javascript:alert(1)">x</a>',
    "<style>body{display:none}</style>",
    '<div style="position:fixed">x</div>',
    "[x](//evil.example)",
    "javascript:alert(1)",
    "| a |\n| - |\n| <script>x</script> |",
    "```\n</code></pre><script>alert(1)</script>\n```",
    "**<svg onload=alert(1)>**",
  ];

  for (const attack of ATTACKS) {
    it(`renders an attack as text: ${JSON.stringify(attack).slice(0, 60)}`, () => {
      const out = html(attack);
      expect(out).not.toMatch(/<script|<img|<iframe|<svg|<style/i);
      expect(out).not.toMatch(/<[a-z][^>]*\son\w+=/i);
      expect(out).not.toMatch(/<[a-z][^>]*\sstyle=/i);
      for (const match of out.matchAll(/href="([^"]*)"/g)) expect(match[1]).toMatch(/^https?:\/\//);
    });
  }
});

describe("SourceList", () => {
  it("keeps a source with an unsafe link in its place, so the numbers stay right", () => {
    const out = renderToStaticMarkup(
      createElement(SourceList, {
        sources: [
          { title: "Bad", url: "javascript:alert(1)" },
          { title: "Good", url: "https://example.com/" },
        ],
      }),
    );
    expect(out.match(/<li>/g)).toHaveLength(2);
    expect(out).toContain("Link removed");
    expect(out.indexOf("Bad")).toBeLessThan(out.indexOf("Good"));
    expect(out).not.toContain("javascript:");
  });
});

describe("no HTML injection in chat code", () => {
  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : [path];
    });
  }

  it("no chat file sets HTML from a string", () => {
    for (const file of files(join(process.cwd(), "src/features/chat"))) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/dangerouslySetInnerHTML|innerHTML|outerHTML|insertAdjacentHTML/);
    }
  });
});
