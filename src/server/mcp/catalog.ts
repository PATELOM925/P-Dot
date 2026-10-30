import "server-only";
import { z } from "zod";
import type { AssistantToolName } from "@/types/api";
import { MCP_SERVER_IDS, type McpServerId } from "@/lib/connectors";
import { githubFindRepo, githubMyWork } from "./github-tools";
import type { RemoteStep, StepCaller } from "./steps";

// The MCP servers P-Dot can connect, and the read tools P-Dot owns for each
// (decision 0016). The model sees only the names, descriptions and argument
// schemas written here, never a server's own tool definitions.

export { MCP_SERVER_IDS, type McpServerId };

/** Which argument goes out under which outbound rule (src/server/mcp/outbound.ts). */
export type OutboundRule = { kind: "words"; field: string } | { kind: "id"; field: string } | { kind: "none" };

interface CatalogToolBase<Args extends Record<string, unknown>> {
  name: AssistantToolName;
  description: string;
  guidance: string;
  args: z.ZodType<Args>;
  outbound: OutboundRule;
  maxCallsPerTurn: number;
  statusQuery(args: Args): string | undefined;
  /**
   * The tool came after the first release of its app. A connection made before
   * it has no pin for it, so chat and the Connectors card tell the user to
   * connect the app again (decision 0020).
   */
  addedLater?: boolean;
}

/** A tool that makes one remote call. */
export interface OneCallTool<Args extends Record<string, unknown> = Record<string, unknown>> extends CatalogToolBase<Args> {
  /** The server's tool name. */
  remote: string;
  /** The arguments P-Dot sends. Built only from the checked arguments and constants. */
  remoteArgs(args: Args): Record<string, unknown>;
  /** The argument names `remoteArgs` can send, for the compatibility check at Connect. */
  sends: readonly string[];
  steps?: undefined;
  run?: undefined;
}

/** A tool that makes several remote calls in an order written in code (src/server/mcp/steps.ts). */
export interface StepsTool<Args extends Record<string, unknown> = Record<string, unknown>> extends CatalogToolBase<Args> {
  /** Every remote tool `run` can call. All must be pinned for the tool to be ready. */
  steps: readonly RemoteStep[];
  /** The text for the model. Calls only remote tools in `steps`, through `caller`. */
  run(caller: StepCaller, args: Args): Promise<string>;
  remote?: undefined;
}

export type CatalogTool<Args extends Record<string, unknown> = Record<string, unknown>> = OneCallTool<Args> | StepsTool<Args>;

/** The remote tools a catalog tool calls. */
export function remoteSteps(tool: CatalogTool): readonly RemoteStep[] {
  return tool.steps ?? [{ remote: tool.remote, sends: tool.sends }];
}

/** True when every remote tool that the catalog tool calls has a pin. */
export function isToolPinned(tool: CatalogTool, pins: Readonly<Record<string, string>>): boolean {
  return remoteSteps(tool).every((step) => Boolean(pins[step.remote]));
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
  /**
   * "public": the client ID is P-Dot's CIMD URL, else one from DCR. "confidential":
   * the app has neither, so the owner registers a client and its ID and secret
   * come from env (decision 0020). The secret goes only to the token endpoint.
   */
  client: "public" | "confidential";
  /** The scope P-Dot asks for. Null: no scope parameter, and P-Dot stores `acceptedScopes` as a label. */
  scope: string | null;
  /** Scopes P-Dot accepts in a token answer and stores. Keep in step with connected_accounts_known_scopes. */
  acceptedScopes: readonly string[];
  tools: readonly CatalogTool[];
  /** Most remote calls in one turn for this app, over all its tools. Unset: only each tool's own limit. */
  maxRemoteCallsPerTurn?: number;
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
  client: "public",
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
  client: "public",
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
  client: "public",
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

// GitHub (decision 0020): the official server's read-only URL. A GitHub App
// with read-only permissions, registered by the owner, is the client.
const GITHUB_REPO = /^([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})$/;
const GITHUB_REPO_IN_TEXT = /(?<![\w./-])[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}(?![\w/-])/g;
const GITHUB_LINK_IN_TEXT = /https:\/\/(?:www\.)?github\.com\/[^\s<>()"'`]+/gi;
const GITHUB_FILE_LINK = /^https:\/\/(?:www\.)?github\.com\/[^/\s]+\/[^/\s]+\/blob\/[^/\s]+\/\S+$/;

function githubRepo(owner: string, name: string): string | null {
  const id = `${owner}/${name}`;
  const match = GITHUB_REPO.exec(id);
  return match && name !== "." && name !== ".." ? id.toLowerCase() : null;
}

/** The parts of a github.com link: a repository, and a file when the link has `blob/<ref>/<path>`. */
function githubLinkParts(value: string): { repo: string; file: { ref: string; path: string } | null } | null {
  let url: URL;
  try {
    url = new URL(value.replace(/[.,;:!?]+$/, ""));
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !["github.com", "www.github.com"].includes(url.hostname) || url.username || url.password) return null;
  let parts: string[];
  try {
    parts = url.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
  } catch {
    return null;
  }
  const repo = parts.length >= 2 ? githubRepo(parts[0]!, parts[1]!.replace(/\.git$/, "")) : null;
  if (!repo) return null;
  if (parts[2] !== "blob") return { repo, file: null };
  // A file link that P-Dot cannot read safely is no ID at all, not a repository.
  const path = parts.slice(4).join("/");
  if (parts.length < 5 || parts.slice(3).some((part) => part === "." || part === "..") || path.length > 400 || parts[3]!.length > 200) {
    return null;
  }
  return { repo, file: { ref: parts[3]!, path } };
}

/** "owner/name" for a repository, or `https://github.com/owner/name/blob/<ref>/<path>` for a file. Owner and name in lower case. */
export function githubId(value: string): string | null {
  const text = value.trim();
  const repo = GITHUB_REPO.exec(text);
  if (repo) return githubRepo(repo[1]!, repo[2]!);
  const link = githubLinkParts(text);
  if (!link) return null;
  return link.file ? `https://github.com/${link.repo}/blob/${link.file.ref}/${link.file.path}` : link.repo;
}

function githubIdsInText(text: string): string[] {
  const ids = new Set<string>();
  for (const match of text.matchAll(GITHUB_LINK_IN_TEXT)) {
    const link = githubLinkParts(match[0]);
    if (!link) continue;
    ids.add(link.repo);
    if (link.file) ids.add(`https://github.com/${link.repo}/blob/${link.file.ref}/${link.file.path}`);
  }
  for (const match of text.matchAll(GITHUB_REPO_IN_TEXT)) {
    const id = githubId(match[0]);
    if (id) ids.add(id);
  }
  return [...ids];
}

const splitRepo = (id: string) => {
  const [owner, repo] = id.split("/") as [string, string];
  return { owner, repo };
};

const github: McpServer = {
  id: "github",
  client: "confidential",
  name: "GitHub",
  resource: "https://api.githubcopilot.com/mcp/readonly",
  issuer: "https://github.com/login/oauth",
  authOrigins: ["https://github.com"],
  scope: null,
  acceptedScopes: ["read"],
  maxRemoteCallsPerTurn: 3,
  normalizeId: githubId,
  idsInUserText: githubIdsInText,
  resultIds: () => [],
  tools: [
    tool({
      name: "github_search_issues",
      remote: "search_issues",
      description: "Search GitHub issues that the user can see. Returns up to 10 issues.",
      guidance:
        "github_search_issues: search GitHub issues. The query must be one phrase copied word for word from the user's message. You can call it once.",
      args: z.object({ query: query("GitHub issues") }).strict(),
      outbound: { kind: "words", field: "query" },
      remoteArgs: ({ query }) => ({ query, perPage: 10 }),
      sends: ["query", "perPage"],
      maxCallsPerTurn: 1,
      statusQuery: ({ query }) => query,
    }),
    tool({
      name: "github_list_pull_requests",
      remote: "list_pull_requests",
      description: "List the open pull requests of one GitHub repository, for example vercel/next.js. Returns up to 10.",
      guidance:
        "github_list_pull_requests: list open pull requests. Use a repository (owner/name) or a GitHub link from the user's message. When the user names a repository without its owner, use github_find_repo.",
      args: z
        .object({ repo: z.string().trim().regex(/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/).describe("owner/name, from the user's message.") })
        .strict(),
      outbound: { kind: "id", field: "repo" },
      remoteArgs: ({ repo }) => ({ ...splitRepo(repo), state: "open", perPage: 10 }),
      sends: ["owner", "repo", "state", "perPage"],
      maxCallsPerTurn: 2,
      statusQuery: ({ repo }) => repo,
    }),
    tool({
      name: "github_read_file",
      remote: "get_file_contents",
      description: "Read one file from GitHub by its link, for example https://github.com/owner/name/blob/main/README.md.",
      guidance: "github_read_file: read one file. Use a github.com file link (with /blob/) from the user's message.",
      args: z
        .object({ url: z.string().trim().max(700).regex(GITHUB_FILE_LINK).describe("A github.com file link from the user's message.") })
        .strict(),
      outbound: { kind: "id", field: "url" },
      remoteArgs: ({ url }) => {
        const link = githubLinkParts(url)!;
        return { ...splitRepo(link.repo), path: link.file!.path, ref: link.file!.ref };
      },
      sends: ["owner", "repo", "path", "ref"],
      maxCallsPerTurn: 3,
      statusQuery: () => undefined,
    }),
    tool(githubMyWork),
    tool(githubFindRepo),
  ],
};

export const MCP_SERVERS: Record<McpServerId, McpServer> = { notion, linear, todoist, github };

export function mcpServer(id: unknown): McpServer | null {
  return typeof id === "string" && Object.hasOwn(MCP_SERVERS, id) ? MCP_SERVERS[id as McpServerId] : null;
}

/** The provider value in connected_accounts. */
export const providerOf = (server: McpServer) => server.id;
