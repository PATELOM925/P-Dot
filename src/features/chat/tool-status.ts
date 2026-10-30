import type { AssistantToolName } from "@/types/api";

const MAX_QUERY_CHARS = 120;

const LINES: Record<AssistantToolName, (query: string | undefined) => string> = {
  web_search: (query) => (query ? `Searching the web for “${query}”…` : "Searching the web…"),
  search_documents: (query) => (query ? `Searching your documents for “${query}”…` : "Searching your documents…"),
  search_memories: (query) => (query ? `Searching your memories for “${query}”…` : "Searching your memories…"),
  propose_task: () => "Preparing a task for you to approve…",
  propose_reminder: () => "Preparing a reminder for you to approve…",
  save_memory: () => "Preparing a memory for you to keep or not…",
  gmail_search: (query) => (query ? `Searching Gmail for “${query}”…` : "Searching Gmail…"),
  gmail_read: () => "Reading an email…",
  calendar_list_events: () => "Checking your calendar…",
  propose_email: () => "Preparing an email for you to approve…",
  propose_calendar_event: () => "Preparing an event for you to approve…",
};

/** The words for a tool status event. A tool this page does not know gets a general line. */
export function toolStatusLine(tool: string, query: string | undefined): string {
  const short = query && query.length > MAX_QUERY_CHARS ? `${query.slice(0, MAX_QUERY_CHARS - 1)}…` : query;
  const line = Object.hasOwn(LINES, tool) ? LINES[tool as AssistantToolName] : null;
  return line ? line(short) : "P-Dot is using a tool…";
}
