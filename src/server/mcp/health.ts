import "server-only";
import type { McpServerId } from "@/lib/connectors";
import type { McpAccountRepository, McpTokenRow } from "@/server/db/connected-accounts";
import { openBundle } from "./bundle";
import { MCP_SERVERS } from "./catalog";

// What the Connectors cards and the chat toggles show for each MCP app
// (decision 0016). Read on the server; the token never leaves the Worker.

export interface McpConnectionView {
  server: McpServerId;
  status: "connected" | "needs_reconnect";
  /** When this connection was made. */
  connectedAt: string;
  /** Catalog tools pinned at Connect, by P-Dot name. */
  ready: string[];
  /** Catalog tools the app did not offer in a compatible form. */
  missing: string[];
  /** No refresh token: access ends when the access token ends. */
  noRefresh: boolean;
  /** The bundle does not open (changed key or row). Chat does not use it. */
  unreadable: boolean;
}

export async function viewOf(key: Uint8Array, userId: string, row: McpTokenRow): Promise<McpConnectionView> {
  const server = MCP_SERVERS[row.provider];
  const bundle = await openBundle(key, userId, server, row.subject, row.tokenCiphertext);
  const ready = bundle ? server.tools.filter((tool) => bundle.pins[tool.remote]).map((tool) => tool.name) : [];
  return {
    server: row.provider,
    status: row.status,
    connectedAt: row.createdAt,
    ready,
    missing: server.tools.map((tool) => tool.name).filter((name) => !ready.includes(name)),
    noRefresh: bundle !== null && bundle.refreshToken === null,
    unreadable: bundle === null,
  };
}

export async function listConnections(repo: McpAccountRepository, key: Uint8Array, userId: string): Promise<McpConnectionView[]> {
  const rows = await repo.listMcp(userId);
  return Promise.all(rows.map((row) => viewOf(key, userId, row)));
}

/** The apps a chat message can turn on: connected, readable, and with at least one tool ready. */
export function usableApps(views: readonly McpConnectionView[]): McpServerId[] {
  return views.filter((view) => view.status === "connected" && !view.unreadable && view.ready.length > 0).map((view) => view.server);
}
