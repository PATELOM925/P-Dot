import "server-only";
import type { ToolCall, ToolDefinition } from "./client";

// Some models (Nemotron on Nebius) sometimes write a tool call as text in
// `content`, in the hermes or qwen form, in place of `tool_calls`:
//
//   <tool_call>
//   <function=github_list_pull_requests>
//   <parameter=repo>
//   octo/repo
//   </parameter>
//   </function>
//   </tool_call>
//
// or `<tool_call>{"name": ..., "arguments": {...}}</tool_call>`. This filter
// removes all such markup from the visible text, also when it is split across
// chunks, and removes lines that hold only `null`. A whole block that names an
// offered tool becomes a real tool call. Its arguments then go through the same
// zod check as a normal call (checkToolCall). A block that does not parse, or
// names a tool that is not offered, is dropped.

const MAX_CALLS = 8;
const MAX_ARGUMENT_CHARS = 16_000;
/** A block longer than this is dropped and never parsed. */
const MAX_BLOCK_CHARS = 16_000;
/** The longest tag P-Dot recognizes, so a partial tag at the end of a chunk is held back. */
const MAX_TAG_CHARS = 100;

const TAG = /^<(\/?)(tool_call|function|parameter)(=[^<>\n]{1,80})?\s*>/;
const NAME = /^[A-Za-z0-9_.-]{1,64}$/;

type BlockKind = "tool_call" | "function" | "parameter";

export interface ToolMarkupFilter {
  /** The part of `text` that is safe to show. */
  push(text: string): string;
  /** Held text at the end of the stream. */
  flush(): string;
  /** The tool calls parsed from whole blocks. */
  calls(): ToolCall[];
}

/** True when `text` (which starts with "<") can still grow into a tag. */
function couldBeTag(text: string): boolean {
  if (text.length >= MAX_TAG_CHARS || text.includes(">") || text.includes("\n")) return false;
  const body = text.slice(1).replace(/^\//, "");
  if (body.length === 0) return true;
  return ["tool_call", "function", "parameter"].some((name) => name.startsWith(body) || body.startsWith(`${name}=`) || body === name);
}

/** The JSON Schema type of one parameter, if the tool has a simple one. */
function paramType(tool: ToolDefinition, name: string): string | null {
  const properties = (tool.parameters as { properties?: Record<string, { type?: unknown }> }).properties;
  const type = properties && Object.hasOwn(properties, name) ? properties[name]?.type : undefined;
  return typeof type === "string" ? type : null;
}

/** A text value as the type the schema asks for. A value that does not convert stays text, and zod refuses it later. */
function coerce(value: string, type: string | null): unknown {
  if (type === "string") return value;
  if (type === "number" || type === "integer") {
    const number = Number(value);
    return value.trim() !== "" && Number.isFinite(number) ? number : value;
  }
  if (type === "boolean") return value === "true" ? true : value === "false" ? false : value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function qwenArguments(tool: ToolDefinition, body: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const match of body.matchAll(/<parameter=([^<>\n]{1,64})>([\s\S]*?)<\/parameter>/g)) {
    const name = match[1]!.trim();
    const value = match[2]!.replace(/^\n/, "").replace(/\n$/, "");
    if (!NAME.test(name) || value.trim() === "null" || Object.hasOwn(args, name)) continue;
    args[name] = coerce(value, paramType(tool, name));
  }
  return args;
}

/** The call in one block, or null. `opener` is the `=name` part of a `<function=name>` opening tag. */
function parseBlock(kind: BlockKind, opener: string, body: string, tools: ReadonlyMap<string, ToolDefinition>): { name: string; args: unknown } | null {
  if (kind === "function") {
    const tool = tools.get(opener.slice(1).trim());
    return tool ? { name: tool.name, args: qwenArguments(tool, body) } : null;
  }
  const text = body.trim();
  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text) as { name?: unknown; arguments?: unknown };
      const tool = typeof parsed.name === "string" ? tools.get(parsed.name) : undefined;
      if (!tool) return null;
      const args = typeof parsed.arguments === "string" ? JSON.parse(parsed.arguments) : (parsed.arguments ?? {});
      return { name: tool.name, args };
    } catch {
      return null;
    }
  }
  const fn = /<function=([^<>\n]{1,64})>/.exec(text);
  const tool = fn ? tools.get(fn[1]!.trim()) : undefined;
  return tool ? { name: tool.name, args: qwenArguments(tool, text.slice(fn!.index + fn![0].length)) } : null;
}

/** Drops lines that hold only `null`. The last line is held while it can still become `null`. */
function createNullLineFilter() {
  let held = "";
  let atLineStart = true;
  return {
    push(text: string): string {
      const all = held + text;
      held = "";
      if (!all) return "";
      const startsLine = atLineStart;
      const parts = all.split("\n");
      const last = parts.pop()!;
      let out = "";
      parts.forEach((line, index) => {
        if (line.trim() === "null" && (index > 0 || startsLine)) return;
        out += `${line}\n`;
      });
      const lastStartsLine = parts.length > 0 || startsLine;
      const core = last.trim();
      if (lastStartsLine && core.length > 0 && "null".startsWith(core)) held = last;
      else out += last;
      if (out) atLineStart = out.endsWith("\n");
      else if (parts.length > 0) atLineStart = true;
      return out;
    },
    flush(): string {
      const rest = held.trim() === "null" ? "" : held;
      held = "";
      return rest;
    },
  };
}

export function createToolMarkupFilter(offered: readonly ToolDefinition[] = []): ToolMarkupFilter {
  const tools = new Map(offered.map((tool) => [tool.name, tool]));
  const calls: ToolCall[] = [];
  const lines = createNullLineFilter();
  let buffer = "";
  // The open block, if any: its kind, the `=name` of its tag, and its text so far.
  let block: { kind: BlockKind; opener: string; body: string; tooLong: boolean } | null = null;
  // After a removed tag, one line break is removed too, so no empty line stays.
  let dropBreak = false;

  function closeBlock(): void {
    const open = block!;
    block = null;
    if (open.tooLong || open.kind === "parameter" || calls.length >= MAX_CALLS) return;
    const parsed = parseBlock(open.kind, open.opener, open.body, tools);
    if (!parsed || !parsed.args || typeof parsed.args !== "object" || Array.isArray(parsed.args)) return;
    const args = JSON.stringify(parsed.args);
    if (args.length > MAX_ARGUMENT_CHARS) return;
    calls.push({ id: `text_call_${calls.length}`, name: parsed.name, arguments: args });
  }

  function scan(final: boolean): string {
    let out = "";
    for (;;) {
      if (dropBreak && buffer.length > 0) {
        if (buffer.startsWith("\n")) buffer = buffer.slice(1);
        dropBreak = false;
      }
      if (block) {
        const end = `</${block.kind}>`;
        const at = buffer.indexOf(end);
        if (at === -1) {
          // Keep enough to find an end tag split across chunks.
          const keep = final ? 0 : end.length - 1;
          const take = Math.max(0, buffer.length - keep);
          block.body += buffer.slice(0, take);
          if (block.body.length > MAX_BLOCK_CHARS) {
            block.body = "";
            block.tooLong = true;
          }
          buffer = buffer.slice(take);
          if (final) {
            // A block that never closed: try it, then drop its text.
            closeBlock();
            buffer = "";
          }
          return out;
        }
        if (!block.tooLong) block.body += buffer.slice(0, at);
        buffer = buffer.slice(at + end.length);
        closeBlock();
        dropBreak = true;
        continue;
      }
      const lt = buffer.indexOf("<");
      if (lt === -1) {
        out += buffer;
        buffer = "";
        return out;
      }
      out += buffer.slice(0, lt);
      buffer = buffer.slice(lt);
      const tag = TAG.exec(buffer);
      if (!tag) {
        if (!final && couldBeTag(buffer)) return out;
        out += "<";
        buffer = buffer.slice(1);
        continue;
      }
      buffer = buffer.slice(tag[0].length);
      dropBreak = true;
      const closing = tag[1] === "/";
      const kind = tag[2] as BlockKind;
      const opener = tag[3] ?? "";
      // An opening tag starts a block. A closing tag without its block, and a
      // bare `<function>`, are stray markup: removed and nothing else.
      if (!closing && (kind === "tool_call" || opener)) block = { kind, opener, body: "", tooLong: false };
    }
  }

  return {
    push(text) {
      buffer += text;
      return lines.push(scan(false));
    },
    flush() {
      const rest = lines.push(scan(true));
      return rest + lines.flush();
    },
    calls: () => [...calls],
  };
}
