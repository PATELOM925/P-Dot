import "server-only";
import { z } from "zod";
import type { AssistantToolName } from "@/types/api";
import { MCP_SERVER_IDS, type McpServerId } from "@/lib/connectors";

// The MCP servers P-Dot can connect, and the read tools P-Dot owns for each
// (decision 0016). The model sees only the names, descriptions and argument
// schemas written here, never a server's own tool definitions.

export { MCP_SERVER_IDS, type McpServerId };

/** Which argument goes out under which outbound rule (src/server/mcp/outbound.ts). */
export type OutboundRule = { kind: "words"; field: string } | { kind: "id"; field: string } | { kind: "none" };

export interface CatalogTool<Args extends Record<string, unknown> = Record<string, unknown>> {
  name: AssistantToolName;
  /** The server's tool name. */
  remote: string;
  description: string;
  guidance: string;
  args: z.ZodType<Args>;
  outbound: OutboundRule;
  /** The arguments P-Dot sends. Built only from the checked arguments and constants. */
  remoteArgs(args: Args): Record<string, unknown>;
  /** The argument names `remoteArgs` can send, for the compatibility check at Connect. */
  sends: readonly string[];
  maxCallsPerTurn: number;
  statusQuery(args: Args): string | undefined;
}

export interface McpServer {
  id: McpServerId;
  name: string;
  /** The MCP endpoint and the OAuth resource (RFC 8707). */
  resource: string;
  /** The authorization server's issuer, compared by exact string. */
  issuer: string;
  /** Every OAuth endpoint from discovery must be https on one of these origins. */
  authOrigins: readonly string[];
  /** The scope P-Dot asks for. */
  scope: string;
  /** Scopes P-Dot accepts in a token answer and stores. Keep in step with connected_accounts_known_scopes. */
  acceptedScopes: readonly string[];
  tools: readonly CatalogTool[];
  /** The app's form of an ID, so two spellings of one ID compare equal. Null when it is not an ID of this app. */
  normalizeId(value: string): string | null;
  /** IDs with the app's format in the user's message. */
  idsInUserText(text: string): string[];
  /** IDs from the typed ID fields of a result, parsed with a P-Dot schema. Text matches never count. */
  resultIds(result: unknown): string[];
}

const loose = <T extends z.ZodRawShape>(shape: T) => z.object(shape).loose();

function parsedIds(schema: z.ZodType<{ id: string }[]>, result: unknown): string[] {
  const parsed = schema.safeParse(result);
  return parsed.success ? parsed.data.map((item) => item.id) : [];
}

const HEX32 = /^[0-9a-f]{32}$/;
const NOTION_ID_IN_TEXT = /[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}/gi;

function notionId(value: string): string | null {
  const hex = value.trim().toLowerCase().replace(/-/g, "");
  if (!HEX32.test(hex)) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const LINEAR_IDENTIFIER = /^[A-Z][A-Z0-9]{0,9}-\d{1,7}$/;
const LINEAR_IDENTIFIER_IN_TEXT = /\b[A-Z][A-Z0-9]{0,9}-\d{1,7}\b/g;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function linearId(value: string): string | null {
  const text = value.trim();
  if (LINEAR_IDENTIFIER.test(text)) return text;
  return UUID.test(text.toLowerCase()) ? text.toLowerCase() : null;
}

const query = (what: string) =>
  z.string().trim().min(1).max(120).describe(`One phrase copied from the user's message, to search ${what}.`)
const id = (what: string) => z.string().trim().min(1).max(200).describe(what);

function tool<Args extends Record<string, unknown>>(spec: CatalogTool<Args>): CatalogTool {
  return spec as unknown as CatalogTool;
}

const notion: McpServer = {
  id: "notion",
  name: "Notion",
  resource: "https://mcp.notion.com/mcp",
  issuer: "https://mcp.notion.com",
  authOrigins: ["https://mcp.notion.com"],
  scope: "default",
  acceptedScopes: ["default"],
  normalizeId: notionId,
  idsInUserText: (text) => [...text.matchAll(NOTION_ID_IN_TEXT)].map((match) => notionId(match[0])!),
  resultIds: (result) => parsedIds(loose({ results: z.array(loose({ id: z.string().max(200) })).max(50) }).transform((r) => r.results), result),
  tools: [
    tool({
      name: "notion_search",
      remote: "notion-search",
      description: "Search the user's Notion pages. Returns page titles and IDs.",
      guidance:
        "notion_search: search the user's Notion. The query must be one phrase copied word for word from the user's message. You can call it once.",
      args: z.object({ query: query("Notion") }).strict(),
      outbound: { kind: "words", field: "query" },
      remoteArgs: ({ query }) => ({ query }),
      sends: ["query"],
      maxCallsPerTurn: 1,
      statusQuery: ({ query }) => query,
    }),
    tool({
      name: "notion_fetch",
      remote: "notion-fetch",
      description: "Read one Notion page by its ID or link.",
      guidance:
        "notion_fetch: read one Notion page. Use an ID that notion_search returned in this turn, or a link in the user's message.",
      args: z.object({ id: id("A page ID from notion_search in this turn, or a Notion link from the user's message.") }).strict(),
      outbound: { kind: "id", field: "id" },
      remoteArgs: ({ id }) => ({ id }),
      sends: ["id"],
      maxCallsPerTurn: 3,
      statusQuery: () => undefined,
    }),
  ],
};

const linear: McpServer = {
  id: "linear",
  name: "Linear",
  resource: "https://mcp.linear.app/mcp",
  issuer: "https://mcp.linear.app",
  authOrigins: ["https://mcp.linear.app"],
  scope: "read",
  acceptedScopes: ["read"],
  normalizeId: linearId,
  idsInUserText: (text) => [...text.matchAll(LINEAR_IDENTIFIER_IN_TEXT)].map((match) => match[0]),
  resultIds: (result) =>
    parsedIds(loose({ issues: z.array(loose({ id: z.string().max(200) })).max(50) }).transform((r) => r.issues), result),
  tools: [
    tool({
      name: "linear_search_issues",
      remote: "list_issues",
      description: "Search the user's Linear issues by title and description. Returns up to 10 issues.",
      guidance:
        "linear_search_issues: search the user's Linear issues. The query must be one phrase copied word for word from the user's message. You can call it once.",
      args: z.object({ query: query("Linear issues") }).strict(),
      outbound: { kind: "words", field: "query" },
      remoteArgs: ({ query }) => ({ query, limit: 10 }),
      sends: ["query", "limit"],
      maxCallsPerTurn: 1,
      statusQuery: ({ query }) => query,
    }),
    tool({
      name: "linear_get_issue",
      remote: "get_issue",
      description: "Read one Linear issue by its ID or identifier, for example ENG-123.",
      guidance:
        "linear_get_issue: read one Linear issue. Use an ID that linear_search_issues returned in this turn, or one in the user's message.",
      args: z.object({ id: id("An issue ID or identifier from this turn's results or the user's message.") }).strict(),
      outbound: { kind: "id", field: "id" },
      remoteArgs: ({ id }) => ({ id }),
      sends: ["id"],
      maxCallsPerTurn: 3,
      statusQuery: () => undefined,
    }),
  ],
};

const todoist: McpServer = {
  id: "todoist",
  name: "Todoist",
  resource: "https://ai.todoist.net/mcp",
  issuer: "https://todoist.com",
  authOrigins: ["https://todoist.com", "https://ai.todoist.net"],
  scope: "data:read",
  acceptedScopes: ["data:read", "data:read_write"],
  normalizeId: () => null,
  idsInUserText: () => [],
  resultIds: () => [],
  tools: [
    tool({
      name: "todoist_list_tasks",
      remote: "find-tasks-by-date",
      description: "List the user's Todoist tasks that are due from today for a number of days.",
      guidance: "todoist_list_tasks: list the user's Todoist tasks due from today.",
      args: z
        .object({ days: z.number().int().min(1).max(14).describe("How many days from today, 1 to 14.") })
        .strict(),
      outbound: { kind: "none" },
      remoteArgs: ({ days }) => ({ startDate: "today", daysCount: days }),
      sends: ["startDate", "daysCount"],
      maxCallsPerTurn: 2,
      statusQuery: () => undefined,
    }),
    tool({
      name: "todoist_find_tasks",
      remote: "find-tasks",
      description: "Search the user's Todoist tasks by text. Returns up to 10 tasks.",
      guidance: "todoist_find_tasks: search the user's Todoist tasks. The text must be one phrase copied word for word from the user's message. You can call it once.",
      args: z.object({ text: query("Todoist tasks") }).strict(),
      outbound: { kind: "words", field: "text" },
      remoteArgs: ({ text }) => ({ searchText: text, limit: 10 }),
      sends: ["searchText", "limit"],
      maxCallsPerTurn: 1,
      statusQuery: ({ text }) => text,
    }),
  ],
};

export const MCP_SERVERS: Record<McpServerId, McpServer> = { notion, linear, todoist };

export function mcpServer(id: unknown): McpServer | null {
  return typeof id === "string" && Object.hasOwn(MCP_SERVERS, id) ? MCP_SERVERS[id as McpServerId] : null;
}

/** The provider value in connected_accounts. */
export const providerOf = (server: McpServer) => server.id;
