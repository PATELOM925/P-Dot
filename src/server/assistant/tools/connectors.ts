import "server-only";
import { MCP_SERVERS, type CatalogTool, type McpServer } from "@/server/mcp/catalog";
import { CONNECTOR_GUIDANCE } from "@/server/mcp/results";
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
