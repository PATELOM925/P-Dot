// A small Markdown parser for assistant replies. It returns a tree of plain
// data; Markdown.tsx turns it into React elements. Raw HTML is never parsed:
// "<b>" stays the text "<b>". No dependency, so it runs the same on Workers.

export type Inline =
  | { type: "text"; text: string }
  | { type: "strong" | "em" | "del"; children: Inline[] }
  | { type: "code"; text: string }
  | { type: "link"; href: string; children: Inline[] }
  | { type: "image"; href: string; alt: string }
  | { type: "break" }
  /** A citation mark "[n]": source n of the reply (1-based). */
  | { type: "cite"; n: number };

export interface ListItem {
  task: "open" | "done" | null;
  content: Inline[];
  children: Block[];
}

export type Block =
  | { type: "paragraph"; content: Inline[] }
  | { type: "heading"; level: number; content: Inline[] }
  | { type: "code"; lang: string; text: string; open: boolean }
  | { type: "quote"; children: Block[] }
  | { type: "list"; ordered: boolean; start: number; items: ListItem[] }
  | { type: "table"; head: Inline[][]; rows: Inline[][][]; align: ("left" | "center" | "right" | null)[] }
  | { type: "rule" };

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
// Line rules are plain scans or regexes with one unambiguous quantifier, so a long line costs
// linear time. No nested or adjacent overlapping quantifiers (tests/unit/markdown.test.ts).
const HEADING_START = /^ {0,3}(#{1,6})(?=[ \t]|$)/;
const QUOTE = /^ {0,3}>\s?(.*)$/;

function isFenceLine(line: string): boolean {
  const fence = FENCE.exec(line);
  return fence !== null && !(fence[1]![0] === "`" && fence[2]!.includes("`"));
}
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const SEPARATOR_CELL = /^:?-+:?$/;

/** "## Title ##" as level 2 and "Title", or null. */
function readHeading(line: string): { level: number; text: string } | null {
  const start = HEADING_START.exec(line);
  if (!start) return null;
  let text = line.slice(start[0].length).trim();
  // A closing run of "#" counts only after a space, as in CommonMark.
  let end = text.length;
  while (end > 0 && text[end - 1] === "#") end -= 1;
  if (end < text.length && (end === 0 || text[end - 1] === " " || text[end - 1] === "\t")) text = text.slice(0, end).trim();
  return { level: start[1]!.length, text };
}

/** "---", "* * *" or "___": 3 or more of one mark, with spaces only between them. */
function isRule(line: string): boolean {
  if (/^ {4}/.test(line)) return false;
  let mark = "";
  let count = 0;
  for (const char of line) {
    if (char === " " || char === "\t") continue;
    if (char !== "-" && char !== "*" && char !== "_") return false;
    if (mark && char !== mark) return false;
    mark = char;
    count += 1;
  }
  return count >= 3;
}

/** The row under a table head: cells like "---", ":--", "--:" or ":-:", split by "|". */
function isTableSeparator(line: string): boolean {
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|")) row = row.slice(0, -1);
  if (!row.includes("-")) return false;
  return row.split("|").every((cell) => SEPARATOR_CELL.test(cell.trim()));
}
const MAX_DEPTH = 8;

function isBlockStart(line: string): boolean {
  return isFenceLine(line) || readHeading(line) !== null || isRule(line) || QUOTE.test(line) || LIST_ITEM.test(line);
}

function splitRow(line: string): string[] {
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|") && !row.endsWith("\\|")) row = row.slice(0, -1);
  const cells: string[] = [];
  let current = "";
  for (let i = 0; i < row.length; i += 1) {
    if (row[i] === "\\" && row[i + 1] === "|") {
      current += "|";
      i += 1;
    } else if (row[i] === "|") {
      cells.push(current.trim());
      current = "";
    } else {
      current += row[i];
    }
  }
  cells.push(current.trim());
  return cells;
}

function indentOf(line: string): number {
  let width = 0;
  for (const char of line) {
    if (char === " ") width += 1;
    else if (char === "\t") width += 4;
    else break;
  }
  return width;
}

export function parseMarkdown(source: string, depth = 0): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "") {
      i += 1;
      continue;
    }

    const fence = isFenceLine(line) ? FENCE.exec(line) : null;
    if (fence) {
      const marker = fence[1]!;
      const body: string[] = [];
      i += 1;
      let open = true;
      while (i < lines.length) {
        const current = lines[i]!;
        if (current.trim().startsWith(marker[0]!.repeat(marker.length)) && current.trim().replace(/[`~]/g, "") === "") {
          open = false;
          i += 1;
          break;
        }
        body.push(current);
        i += 1;
      }
      blocks.push({ type: "code", lang: (fence[2] ?? "").trim(), text: body.join("\n"), open });
      continue;
    }

    const heading = readHeading(line);
    if (heading) {
      blocks.push({ type: "heading", level: heading.level, content: parseInline(heading.text) });
      i += 1;
      continue;
    }

    if (isRule(line)) {
      blocks.push({ type: "rule" });
      i += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && lines[i]!.trim() !== "" && QUOTE.test(lines[i]!)) {
        body.push(QUOTE.exec(lines[i]!)![1]!);
        i += 1;
      }
      blocks.push({
        type: "quote",
        children: depth < MAX_DEPTH ? parseMarkdown(body.join("\n"), depth + 1) : [paragraph(body)],
      });
      continue;
    }

    if (LIST_ITEM.test(line)) {
      const start = i;
      const base = indentOf(line);
      const ordered = /\d/.test(LIST_ITEM.exec(line)![2]!);
      i += 1;
      while (i < lines.length) {
        const current = lines[i]!;
        if (current.trim() === "") {
          const next = lines[i + 1];
          if (next !== undefined && (LIST_ITEM.test(next) || indentOf(next) > base)) {
            i += 1;
            continue;
          }
          break;
        }
        const item = LIST_ITEM.exec(current);
        // A bullet list followed by a numbered list at the same indent is two lists.
        if (item && indentOf(current) <= base + 1 && /\d/.test(item[2]!) !== ordered) break;
        if (item || indentOf(current) > base) {
          i += 1;
          continue;
        }
        break;
      }
      blocks.push(parseList(lines.slice(start, i), depth));
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1]!)) {
      const head = splitRow(line);
      const align = splitRow(lines[i + 1]!).map((cell) => {
        const left = cell.startsWith(":");
        const right = cell.endsWith(":");
        return left && right ? "center" : right ? "right" : left ? "left" : null;
      });
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && lines[i]!.trim() !== "" && lines[i]!.includes("|")) {
        const cells = splitRow(lines[i]!);
        rows.push(head.map((_, index) => parseInline(cells[index] ?? "")));
        i += 1;
      }
      blocks.push({ type: "table", head: head.map((cell) => parseInline(cell)), rows, align });
      continue;
    }

    const body: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== "" && (body.length === 0 || !isBlockStart(lines[i]!))) {
      body.push(lines[i]!);
      i += 1;
    }
    blocks.push(paragraph(body));
  }
  return blocks;
}

function paragraph(lines: string[]): Block {
  return { type: "paragraph", content: parseInline(lines.map((l) => l.trim()).join("\n")) };
}

function parseList(lines: string[], depth: number): Block {
  const first = LIST_ITEM.exec(lines[0]!)!;
  const base = indentOf(lines[0]!);
  const ordered = /\d/.test(first[2]!);
  const items: { head: string; rest: string[] }[] = [];
  for (const line of lines) {
    const match = LIST_ITEM.exec(line);
    if (match && indentOf(line) <= base + 1) {
      items.push({ head: match[3]!, rest: [] });
    } else if (items.length > 0) {
      items[items.length - 1]!.rest.push(line.slice(Math.min(indentOf(line), base + 2)));
    }
  }
  return {
    type: "list",
    ordered,
    start: ordered ? Number.parseInt(first[2]!, 10) || 1 : 1,
    items: items.map(({ head, rest }) => {
      const task = /^\[([ xX])\]\s+/.exec(head);
      const text = task ? head.slice(task[0].length) : head;
      const nested = rest.join("\n").trim();
      return {
        task: task ? (task[1] === " " ? "open" : "done") : null,
        content: parseInline(text),
        children: nested && depth < MAX_DEPTH ? parseMarkdown(nested, depth + 1) : [],
      };
    }),
  };
}

const BARE_URL = /https?:\/\/[^\s<>()]+/y;
const TRAILING_PUNCTUATION = new Set([".", ",", ";", ":", "!", "?", "'", '"']);
/** [n], and the forms some models write instead (decoded the same on the server): 【n】, 【n†L1-L4】, [n†source]. */
const CITE = /\[(\d{1,2})(?:†[^\]\n]{0,60})?\]|【(\d{1,2})(?:†[^】\n]{0,60})?】/y;

/** Longest link destination read, so a "(" with no ")" costs at most this much. */
const MAX_DESTINATION_CHARS = 2100;

/** For each "[", the index of its matching "]", or -1. One pass with a stack, so unmatched brackets cost nothing more. */
function matchBrackets(text: string): Int32Array {
  const match = new Int32Array(text.length).fill(-1);
  const stack: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\\") i += 1;
    else if (text[i] === "[") stack.push(i);
    else if (text[i] === "]" && stack.length > 0) match[stack.pop()!] = i;
  }
  return match;
}

/** The start of each run of backticks, grouped by run length, in order. */
function backtickRuns(text: string): Map<number, number[]> {
  const runs = new Map<number, number[]>();
  for (let i = 0; i < text.length; ) {
    if (text[i] !== "`") {
      i += 1;
      continue;
    }
    const start = i;
    while (text[i] === "`") i += 1;
    const length = i - start;
    const list = runs.get(length);
    if (list) list.push(start);
    else runs.set(length, [start]);
  }
  return runs;
}

/** The start of the first run of exactly `length` backticks at or after `from`, or -1 (binary search). */
function nextTickRun(runs: Map<number, number[]>, length: number, from: number): number {
  const list = runs.get(length);
  if (!list) return -1;
  let low = 0;
  let high = list.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (list[mid]! < from) low = mid + 1;
    else high = mid;
  }
  return low < list.length ? list[low]! : -1;
}

/** For each "(", the index of its matching ")" on the same line, or -1. One pass with a stack. */
function matchParens(text: string): Int32Array {
  const match = new Int32Array(text.length).fill(-1);
  const stack: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\n") stack.length = 0;
    else if (text[i] === "(") stack.push(i);
    else if (text[i] === ")" && stack.length > 0) match[stack.pop()!] = i;
  }
  return match;
}

export function parseInline(text: string, depth = 0): Inline[] {
  const out: Inline[] = [];
  let buffer = "";
  const flush = () => {
    if (buffer) out.push({ type: "text", text: buffer });
    buffer = "";
  };

  const brackets = matchBrackets(text);
  const tickRuns = backtickRuns(text);
  const parens = matchParens(text);
  // A search for a closing marker that found none from some point finds none from any later point.
  const noneFrom = new Map<string, number>();
  const findClosing = (from: number, marker: string): number => {
    if (from >= (noneFrom.get(marker) ?? Infinity)) return -1;
    let index = text.indexOf(marker, from);
    while (index !== -1 && text[index - 1] === "\\") index = text.indexOf(marker, index + 1);
    if (index === -1) noneFrom.set(marker, Math.min(from, noneFrom.get(marker) ?? Infinity));
    return index;
  };

  let i = 0;
  while (i < text.length) {
    const char = text[i]!;

    if (char === "\\" && i + 1 < text.length && /[\\`*_{}[\]()#+\-.!|~>]/.test(text[i + 1]!)) {
      buffer += text[i + 1];
      i += 2;
      continue;
    }
    if (char === "\n") {
      flush();
      out.push({ type: "break" });
      i += 1;
      continue;
    }
    if (char === "`") {
      // A code span ends at the next run of exactly as many backticks. Each run is counted once,
      // and a run with no match is kept as text in one step, so the scan stays linear.
      let tickCount = 0;
      while (text[i + tickCount] === "`") tickCount += 1;
      const end = nextTickRun(tickRuns, tickCount, i + tickCount);
      if (end !== -1) {
        flush();
        const body = text.slice(i + tickCount, end);
        out.push({ type: "code", text: body.trim() || body });
        i = end + tickCount;
      } else {
        buffer += text.slice(i, i + tickCount);
        i += tickCount;
      }
      continue;
    }
    if (char === "[" || char === "【") {
      CITE.lastIndex = i;
      const cite = CITE.exec(text);
      if (cite && text[i + cite[0].length] !== "(") {
        flush();
        out.push({ type: "cite", n: Number(cite[1] ?? cite[2]) });
        i += cite[0].length;
        continue;
      }
    }
    if ((char === "[" || (char === "!" && text[i + 1] === "[")) && depth < MAX_DEPTH) {
      const image = char === "!";
      const open = image ? i + 1 : i;
      const close = brackets[open]!;
      if (close !== -1 && text[close + 1] === "(") {
        const end = parens[close + 1]!;
        if (end !== -1 && end - close <= MAX_DESTINATION_CHARS) {
          const label = text.slice(open + 1, close);
          const href = text.slice(close + 2, end).trim().split(/\s+/)[0] ?? "";
          flush();
          out.push(image ? { type: "image", href, alt: label } : { type: "link", href, children: parseInline(label, depth + 1) });
          i = end + 1;
          continue;
        }
      }
    }
    if (char === "h" && (i === 0 || /[\s(]/.test(text[i - 1]!))) {
      BARE_URL.lastIndex = i;
      const url = BARE_URL.exec(text);
      if (url) {
        let urlEnd = url[0].length;
        while (urlEnd > 0 && TRAILING_PUNCTUATION.has(url[0][urlEnd - 1]!)) urlEnd -= 1;
        const trimmed = url[0].slice(0, urlEnd);
        flush();
        out.push({ type: "link", href: trimmed, children: [{ type: "text", text: trimmed }] });
        i += trimmed.length;
        continue;
      }
    }
    if (depth < MAX_DEPTH) {
      const strong = text.startsWith("**", i) ? "**" : text.startsWith("__", i) && (i === 0 || /\W/.test(text[i - 1]!)) ? "__" : null;
      if (strong) {
        const end = findClosing(i + 2, strong);
        if (end > i + 2) {
          flush();
          out.push({ type: "strong", children: parseInline(text.slice(i + 2, end), depth + 1) });
          i = end + 2;
          continue;
        }
      }
      if (text.startsWith("~~", i)) {
        const end = findClosing(i + 2, "~~");
        if (end > i + 2) {
          flush();
          out.push({ type: "del", children: parseInline(text.slice(i + 2, end), depth + 1) });
          i = end + 2;
          continue;
        }
      }
      const emphasis = (char === "*" || (char === "_" && (i === 0 || /\W/.test(text[i - 1]!)))) && text[i + 1] !== " " && text[i + 1] !== char;
      if (emphasis) {
        const end = findClosing(i + 1, char);
        const after = text[end + 1];
        if (end > i + 1 && text[end - 1] !== " " && (char === "*" || after === undefined || /\W/.test(after))) {
          flush();
          out.push({ type: "em", children: parseInline(text.slice(i + 1, end), depth + 1) });
          i = end + 1;
          continue;
        }
      }
    }
    buffer += char;
    i += 1;
  }
  flush();
  return out;
}
