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

  const ADVERSARIAL: [string, string][] = [
    ["unmatched [", "[a ".repeat(20_000)],
    ["[x]( with no )", "[x](a ".repeat(10_000)],
    ["unmatched backticks", "`a ``b ".repeat(8_600)],
    ["60,000 backticks in a row", "`".repeat(60_000)],
    ["60,000 inline backticks after text", "a " + "`".repeat(60_000)],
    ["mixed backtick runs", Array.from({ length: 9_000 }, (_, k) => "`".repeat((k % 9) + 1) + "a").join(" ")],
    ["unmatched **", "**a ".repeat(15_000)],
    ["unmatched ~~ and _", "~~a _b ".repeat(8_600)],
  ];
  // The old parser took over 1 s on each of these, so 250 ms still tells the two apart on a busy machine.
  for (const [name, text] of ADVERSARIAL) {
    it(`parses 60k characters of ${name} in under 250 ms`, () => {
      expect(text.length).toBeGreaterThanOrEqual(60_000);
      parseMarkdown("warm up [x](https://example.com)");
      const started = performance.now();
      parseMarkdown(text);
      expect(performance.now() - started).toBeLessThan(250);
    });
  }

  // Line rules: a long line must cost linear time (the old heading and table regexes backtracked).
  const LONG_LINES: [string, string][] = [
    ["a heading of # runs", "# " + "#".repeat(8_000) + "x"],
    ["a heading with spaces and #", "# " + "# ".repeat(4_000) + "x"],
    ["a table separator that fails at the end", "| a | b |\n|-" + " ".repeat(8_000) + "x"],
    ["a table separator of spaces", "| a | b |\n" + " ".repeat(8_000) + "x"],
    ["a rule that fails at the end", "-" + " -".repeat(4_000) + " x"],
    ["a list marker with spaces", "-" + " ".repeat(8_000) + "x"],
    ["a quote of spaces", ">" + " ".repeat(8_000) + "x"],
    ["a URL ending in punctuation", "see https://a.example/" + ".".repeat(8_000) + "x"],
    ["a URL of punctuation only", "see https://a.example/" + ".".repeat(8_000)],
  ];
  for (const [name, line] of LONG_LINES) {
    it(`parses an 8,000-character line with ${name} in under 250 ms`, () => {
      expect(line.length).toBeGreaterThanOrEqual(8_000);
      const started = performance.now();
      for (let k = 0; k < 5; k += 1) parseMarkdown(line);
      expect(performance.now() - started).toBeLessThan(250);
    });
  }

  it("still reads headings, rules and table separators", () => {
    expect(parseMarkdown("## Title ##")[0]).toMatchObject({ type: "heading", level: 2 });
    expect(parseMarkdown("## C# tips")[0]).toMatchObject({ type: "heading", content: [{ type: "text", text: "C# tips" }] });
    expect(parseMarkdown("#nospace")[0]?.type).toBe("paragraph");
    expect(parseMarkdown("* * *")[0]?.type).toBe("rule");
    expect(parseMarkdown("-*-")[0]?.type).not.toBe("rule");
    expect(parseMarkdown("| a | b |\n|:--|--:|\n| 1 | 2 |")[0]?.type).toBe("table");
    expect(parseMarkdown("| a | b |\n| x | y |")[0]?.type).toBe("paragraph");
  });

  it("ends a code span only at a run of the same length", () => {
    expect(parseInline("``a`b`` and `c`")).toEqual([
      { type: "code", text: "a`b" },
      { type: "text", text: " and " },
      { type: "code", text: "c" },
    ]);
    expect(parseInline("a ``` b")).toEqual([{ type: "text", text: "a ``` b" }]);
  });

  it("reads a link destination with balanced parentheses", () => {
    expect(parseInline("[wiki](https://en.wikipedia.org/wiki/Lisbon_(city)) ok")[0]).toMatchObject({
      type: "link",
      href: "https://en.wikipedia.org/wiki/Lisbon_(city)",
    });
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
