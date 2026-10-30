// The MCP apps P-Dot can connect (decision 0016). Shared by the browser and
// the server, so it holds names only, never endpoints or secrets.

export const MCP_SERVER_IDS = ["notion", "linear", "todoist"] as const;
export type McpServerId = (typeof MCP_SERVER_IDS)[number];

export const MCP_SERVER_NAMES: Record<McpServerId, string> = { notion: "Notion", linear: "Linear", todoist: "Todoist" };

export function isMcpServerId(value: unknown): value is McpServerId {
  return typeof value === "string" && (MCP_SERVER_IDS as readonly string[]).includes(value);
}

/** Outcome codes in the Connectors page URL after Connect, the callback or Disconnect. */
export const MCP_OUTCOMES = [
  "connected",
  "denied",
  "error",
  "not_set_up",
  "not_supported",
  "no_tools",
  "wrong_site",
  "rate_limited",
  "disconnected",
  "disconnected_unconfirmed",
  "disconnect_error",
  "disconnect_changed",
  "disconnect_unknown",
  "account_required",
] as const;
export type McpOutcome = (typeof MCP_OUTCOMES)[number];
