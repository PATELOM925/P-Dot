// What the Notion, Linear and Todoist cards on the Connectors page show (decision 0016). Pure, so it is unit-tested.
import { isMcpServerId, MCP_OUTCOMES, MCP_SERVER_NAMES, type McpOutcome } from "@/lib/connectors";
import type { McpConnectionView } from "@/server/mcp/health";

export type McpCardState =
  | { kind: "not_set_up" }
  | { kind: "account_required" }
  | { kind: "load_failed" }
  | { kind: "not_connected" }
  | { kind: "needs_reconnect" }
  | { kind: "connected"; connectedAt: string; ready: string[]; missing: string[]; noRefresh: boolean };

const TOOL_LABELS: Record<string, string> = {
  notion_search: "Search pages",
  notion_fetch: "Read a page",
  linear_search_issues: "Search issues",
  linear_get_issue: "Read an issue",
  todoist_list_tasks: "List tasks due soon",
  todoist_find_tasks: "Search tasks",
};

export function mcpToolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name;
}

export function mcpCardState(
  configured: boolean,
  view: McpConnectionView | null | "load_failed",
  anonymous: boolean,
): McpCardState {
  if (!configured) return { kind: "not_set_up" };
  if (anonymous) return { kind: "account_required" };
  if (view === "load_failed") return { kind: "load_failed" };
  if (!view) return { kind: "not_connected" };
  if (view.status === "needs_reconnect" || view.unreadable) return { kind: "needs_reconnect" };
  return {
    kind: "connected",
    connectedAt: view.connectedAt,
    ready: view.ready.map(mcpToolLabel),
    missing: view.missing.map(mcpToolLabel),
    noRefresh: view.noRefresh,
  };
}

/** A plain date that the server and the browser format the same way. */
export function mcpConnectedDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "an unknown date";
  return date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

/** The message after a Connect or Disconnect redirect, for the app in the URL. Error outcomes use role="alert". */
export function mcpOutcomeMessage(outcome: unknown, app: unknown): { text: string; error: boolean } | null {
  if (typeof outcome !== "string" || !(MCP_OUTCOMES as readonly string[]).includes(outcome)) return null;
  if (!isMcpServerId(app)) return null;
  const name = MCP_SERVER_NAMES[app];
  const messages: Record<McpOutcome, { text: string; error: boolean }> = {
    connected: { text: `${name} is connected.`, error: false },
    denied: { text: `You did not allow access. ${name} is not connected.`, error: true },
    error: { text: `${name} did not connect. Try again.`, error: true },
    not_set_up: { text: `${name} is not set up on this site yet.`, error: true },
    not_supported: { text: `${name} does not support the connection method P-Dot uses.`, error: true },
    no_tools: { text: `${name} did not offer any tool that P-Dot can use. Nothing was saved.`, error: true },
    wrong_site: { text: `Connect ${name} on the main site. It does not work on a preview link.`, error: true },
    rate_limited: { text: `Too many requests for ${name}. Try again later.`, error: true },
    disconnected: { text: `${name} is disconnected. P-Dot removed its access.`, error: false },
    disconnected_unconfirmed: {
      text: `${name} is disconnected from P-Dot, but ${name} did not confirm. You can also remove P-Dot in your ${name} settings.`,
      error: false,
    },
    disconnect_error: { text: `${name} did not disconnect. Try again.`, error: true },
    disconnect_changed: {
      text: `Your ${name} connection changed in another tab while P-Dot disconnected the earlier one. The new connection stays. Disconnect again to remove it.`,
      error: true,
    },
    disconnect_unknown: { text: `We could not confirm that ${name} is disconnected. Check Connectors again.`, error: true },
    account_required: { text: `Create an account to connect ${name}.`, error: true },
  };
  return messages[outcome as McpOutcome];
}
