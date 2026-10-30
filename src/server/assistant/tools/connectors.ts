import "server-only";
import { MCP_SERVERS, type CatalogTool, type McpServer } from "@/server/mcp/catalog";
import { CONNECTOR_GUIDANCE } from "@/server/mcp/results";
import type { ConnectorTools } from "@/server/mcp/connector-turn";
import type { ToolSpec } from "./registry";

// One read tool for each catalog tool (decision 0016). Offered only when the
// user turned the app on for this message and the tool is pinned. The reads
// are `read_sensitive`: the toggle for the message is the approval.

function connectorTool(server: McpServer, tool: CatalogTool, first: boolean): ToolSpec<Record<string, unknown>> {
  return {
    name: tool.name,
    description: tool.description,
    args: tool.args,
    kind: "read",
    source: "connector",
    guidance: first ? `${tool.guidance} ${CONNECTOR_GUIDANCE}` : tool.guidance,
    maxCallsPerTurn: tool.maxCallsPerTurn,
    offered: (flags) => flags.connectors?.get(server.id)?.has(tool.name) === true,
    statusQuery: (args) => tool.statusQuery(args),
    async run(args, context) {
      if (!context.connectors) return { content: `${server.name} is not on for this message. Nothing was read.` };
      return { content: await context.connectors.run(server, tool, args) };
    },
  };
}

export const CONNECTOR_TOOLS: readonly ToolSpec[] = Object.values(MCP_SERVERS).flatMap((server) =>
  server.tools.map((tool, index) => connectorTool(server, tool, index === 0) as ToolSpec),
);

/**
 * One line for each app on this message whose connection is older than one of
 * its tools (decision 0020). The connection keeps working with the tools it
 * has, and the model tells the user how to get the new ones.
 */
export function connectorReconnectNotes(tools: ConnectorTools | undefined): string[] {
  return [...(tools?.entries() ?? [])].flatMap(([id, offered]) => {
    const server = MCP_SERVERS[id];
    if (!server.tools.some((tool) => tool.addedLater && !offered.has(tool.name))) return [];
    return [
      `${server.name} was connected before P-Dot added new ${server.name} tools, so some are not available. If the user asks for something that the tools you have cannot do (for example their own pull requests, or a repository named without its owner), tell them: "Connect ${server.name} again on the Connectors page to use the new tools."`,
    ];
  });
}
