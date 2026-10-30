import type { AssistantToolName } from "@/types/api";

const MAX_QUERY_CHARS = 120;

const LINES: Record<AssistantToolName, (query: string | undefined) => string> = {
  web_search: (query) => (query ? `Searching the web for “${query}”…` : "Searching the web…"),
};

/** The words for a tool status event. A tool this page does not know gets a general line. */
export function toolStatusLine(tool: string, query: string | undefined): string {
  const short = query && query.length > MAX_QUERY_CHARS ? `${query.slice(0, MAX_QUERY_CHARS - 1)}…` : query;
  const line = Object.hasOwn(LINES, tool) ? LINES[tool as AssistantToolName] : null;
  return line ? line(short) : "P-Dot is using a tool…";
}
