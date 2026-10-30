import type { AssistantToolName } from "@/types/api";

const MAX_QUERY_CHARS = 120;

const LINES: Record<AssistantToolName, (query: string | undefined) => string> = {
  web_search: (query) => (query ? `Searching the web for “${query}”…` : "Searching the web…"),
  search_documents: (query) => (query ? `Searching your documents for “${query}”…` : "Searching your documents…"),
  search_memories: (query) => (query ? `Searching your memories for “${query}”…` : "Searching your memories…"),
  propose_task: () => "Preparing a task for you to approve…",
  propose_reminder: () => "Preparing a reminder for you to approve…",
  save_memory: () => "Preparing a memory for you to keep or not…",
  notion_search: (query) => (query ? `Searching Notion for “${query}”…` : "Searching Notion…"),
  notion_fetch: () => "Reading a Notion page…",
  linear_search_issues: (query) => (query ? `Searching Linear for “${query}”…` : "Searching Linear…"),
  linear_get_issue: () => "Reading a Linear issue…",
  todoist_list_tasks: () => "Checking your Todoist tasks…",
  todoist_find_tasks: (query) => (query ? `Searching Todoist for “${query}”…` : "Searching Todoist…"),
};

/** The words for a tool status event. A tool this page does not know gets a general line. */
export function toolStatusLine(tool: string, query: string | undefined): string {
  const short = query && query.length > MAX_QUERY_CHARS ? `${query.slice(0, MAX_QUERY_CHARS - 1)}…` : query;
  const line = Object.hasOwn(LINES, tool) ? LINES[tool as AssistantToolName] : null;
  return line ? line(short) : "P-Dot is using a tool…";
}
