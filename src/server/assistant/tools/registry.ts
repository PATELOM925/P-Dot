import "server-only";
import { z } from "zod";
import type { AssistantToolName, Mode } from "@/types/api";
import type { SpendGuard } from "@/server/db/spend";
import type { Logger } from "@/server/log";
import type { ToolCall, ToolDefinition } from "@/server/providers/model";
import type { WebSearchResult } from "@/server/providers/tavily/client";

// The one place that defines the assistant's tools. A tool is a ToolSpec in
// TOOLS. The set offered for a request is chosen from request flags only
// (`offered`), so the hold made before the stream can price the same tools.
// See docs/ARCHITECTURE.md ("Tools") and docs/decisions/0013-ai-tools-and-scope.md.

/** What a request allows. Each flag comes from the request and server config, never from the model. */
export interface ToolFlags {
  /** The user turned on web search for this message, search is configured, and the search budget allowed it. */
  webSearch: boolean;
}

/**
 * - read: reads data and changes nothing (web search, the user's own P-Dot data).
 * - propose: writes a proposal that waits for the user's approval; it never acts.
 */
export type ToolKind = "read" | "propose";

/** Server services a tool may use. AssistantDeps has all of them. */
export interface ToolServices {
  spend: SpendGuard;
  search: ((query: string, signal: AbortSignal) => Promise<WebSearchResult[]>) | null;
  log: Logger;
}

export interface ToolContext {
  services: ToolServices;
  requestId: string;
  userId: string;
  mode: Mode;
  conversationId: string;
  userMessageId: string;
  signal: AbortSignal;
  /** Web sources the turn already has, in citation order. A tool adds only new URLs. */
  sources: readonly WebSearchResult[];
}

export interface ToolOutcome {
  /** The tool message for the model. Retrieved text in it is delimited as untrusted. */
  content: string;
  /** New web sources, numbered after `ToolContext.sources`. */
  sources?: WebSearchResult[];
}

export interface ToolSpec<Args = unknown> {
  name: AssistantToolName;
  /** Sent to the model. Plain words; no instructions that widen what the tool may do. */
  description: string;
  /** Validates the model's arguments. The JSON schema sent to the model is made from it. */
  args: z.ZodType<Args>;
  kind: ToolKind;
  /** One line for the system prompt when the tool is offered. */
  guidance: string;
  /** Calls allowed in one turn. Later calls get a refusal as their result. */
  maxCallsPerTurn: number;
  offered(flags: ToolFlags): boolean;
  /** What the status event shows: the tool name, and the query when the user should see it. */
  statusQuery(args: Args): string | undefined;
  run(args: Args, context: ToolContext): Promise<ToolOutcome>;
}

/** Tool hops in one turn. After them comes one final pass with tools off. */
export const MAX_TOOL_HOPS = 2;
/** Tool calls run from one model response. Later calls in the same response get a refusal. */
export const MAX_TOOL_CALLS_PER_HOP = 3;

/** JSON schema for the model, from the zod schema. */
export function toToolDefinition(spec: ToolSpec): ToolDefinition {
  const { $schema: _schema, ...parameters } = z.toJSONSchema(spec.args) as Record<string, unknown>;
  void _schema;
  return { name: spec.name, description: spec.description, parameters };
}

/** The tools offered for a request, in the order of `all`. */
export function selectTools(all: readonly ToolSpec[], flags: ToolFlags): ToolSpec[] {
  return all.filter((spec) => spec.offered(flags));
}

export type ToolCallResult =
  | { status: "ran"; spec: ToolSpec; query: string | undefined; outcome: ToolOutcome }
  | { status: "refused"; content: string };

/**
 * Checks one call before it runs: an offered tool, under its limit, with
 * arguments that parse as JSON and pass the zod schema. Returns the parsed
 * arguments or the refusal the model gets as the tool result.
 */
export function checkToolCall(
  offered: readonly ToolSpec[],
  call: ToolCall,
  callsSoFar: ReadonlyMap<string, number>,
): { ok: true; spec: ToolSpec; args: unknown } | { ok: false; content: string } {
  const spec = offered.find((candidate) => candidate.name === call.name);
  if (!spec) return { ok: false, content: "This tool is not available in this request. Nothing was done." };
  if ((callsSoFar.get(spec.name) ?? 0) >= spec.maxCallsPerTurn) {
    return { ok: false, content: `The limit for ${spec.name} in this turn is reached. Nothing was done. Answer with what you have.` };
  }
  let raw: unknown;
  try {
    raw = call.arguments.trim() === "" ? {} : JSON.parse(call.arguments);
  } catch {
    return { ok: false, content: "The arguments were not valid JSON. Nothing was done." };
  }
  const parsed = spec.args.safeParse(raw);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".") || "(arguments)"))].join(", ");
    return { ok: false, content: `The arguments were not valid (${fields}). Nothing was done.` };
  }
  return { ok: true, spec, args: parsed.data };
}
