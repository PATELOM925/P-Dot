import type { AssistantToolName, ResearchStep } from "@/types/api";

const MAX_QUERY_CHARS = 120;

const LINES: Record<AssistantToolName | ResearchStep, (query: string | undefined, count: number | undefined) => string> = {
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
  notion_search: (query) => (query ? `Searching Notion for “${query}”…` : "Searching Notion…"),
  notion_fetch: () => "Reading a Notion page…",
  linear_search_issues: (query) => (query ? `Searching Linear for “${query}”…` : "Searching Linear…"),
  linear_get_issue: () => "Reading a Linear issue…",
  todoist_list_tasks: () => "Checking your Todoist tasks…",
  todoist_find_tasks: (query) => (query ? `Searching Todoist for “${query}”…` : "Searching Todoist…"),
  github_search_issues: (query) => (query ? `Searching GitHub issues for “${query}”…` : "Searching GitHub issues…"),
  github_list_pull_requests: (query) => (query ? `Listing pull requests in ${query}…` : "Listing pull requests…"),
  github_read_file: () => "Reading a GitHub file…",
  github_my_work: () => "Checking your GitHub…",
  github_find_repo: (query) => (query ? `Finding your GitHub repository “${query}”…` : "Finding your GitHub repository…"),
  research_search: () => "Searching the web (deep)…",
  research_read: (_query, count) => (count === 1 ? "Reading 1 page…" : `Reading ${count ?? "the top"} pages…`),
  research_write: () => "Writing the brief…",
  brief_search: (query) => (query ? `Searching today's news for “${query}”…` : "Searching today's news…"),
};

/** The words for a tool status event. A tool this page does not know gets a general line. */
export function toolStatusLine(tool: string, query: string | undefined, count?: number): string {
  const short = query && query.length > MAX_QUERY_CHARS ? `${query.slice(0, MAX_QUERY_CHARS - 1)}…` : query;
  const line = Object.hasOwn(LINES, tool) ? LINES[tool as AssistantToolName | ResearchStep] : null;
  return line ? line(short, typeof count === "number" && Number.isInteger(count) && count > 0 ? count : undefined) : "P-Dot is using a tool…";
}
