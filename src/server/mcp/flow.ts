import "server-only";
import { NextResponse } from "next/server";
import { MCP_OUTCOMES, type McpOutcome } from "@/lib/connectors";
import { getMcpConfig } from "@/server/config";
import { logEvent } from "@/server/log";
import type { McpServerId } from "./catalog";
import { MCP_STATE_COOKIE, MCP_STATE_PATH } from "./state";

// Shared by the MCP Connect, callback and Disconnect routes (decision 0016).
// Each answers with a 303 back to the Connectors page and a short outcome
// code. The code never carries data.

export { MCP_OUTCOMES, type McpOutcome };

export function backToConnectors(request: Request, server: McpServerId | null, outcome: McpOutcome, clearState = false): NextResponse {
  const query = server ? `mcp=${outcome}&app=${server}#${server}` : `mcp=${outcome}`;
  const response = NextResponse.redirect(new URL(`/connectors?${query}`, request.url), 303);
  if (clearState) response.cookies.set(MCP_STATE_COOKIE, "", { path: MCP_STATE_PATH, maxAge: 0, httpOnly: true });
  return response;
}

/** The sealing key, or null after logging that the name is bad (never the value). */
export function readyMcpKey(requestId: string, route: string): Uint8Array | null {
  const state = getMcpConfig();
  if (state.status === "ready") return state.encryptionKey;
  if (state.invalid) logEvent("error", "mcp_config_invalid", { requestId, route, names: "CONNECTOR_TOKEN_ENCRYPTION_KEY" });
  return null;
}

/** Calls an app with the global fetch at call time, so tests can replace it. */
export const mcpFetch = (input: string, init?: RequestInit) => fetch(input, init);
