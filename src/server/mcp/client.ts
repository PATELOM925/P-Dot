import "server-only";
import { z } from "zod";
import type { FetchLike } from "@/server/google/http";
import { pinOf, type RemoteTool } from "./pins";

// A small MCP client over Streamable HTTP (decision 0016). JSON-RPC with plain
// fetch: initialize, tools/list for the pin check, and tools/call. One session
// for each app for each turn. Answers are bounded and checked with zod. Every
// stream reader is cancelled in `finally`. No GET stream, no retries of a call.

export const PROTOCOL_VERSION = "2025-06-18";
export const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26"] as const;
export const REQUEST_TIMEOUT_MS = 10_000;
export const MAX_CALL_BYTES = 256 * 1024;
export const MAX_INIT_BYTES = 64 * 1024;
const MAX_LIST_PAGES = 3;

export type McpErrorKind = "unauthorized" | "forbidden" | "rejected" | "unavailable" | "timeout" | "too_large" | "bad_response";

export class McpError extends Error {
  override readonly name = "McpError";
  constructor(
    readonly kind: McpErrorKind,
    readonly status: number | null = null,
  ) {
    super(`MCP request failed: ${kind}`);
  }
}

function kindFor(status: number): McpErrorKind {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 408 || status === 429 || status >= 500) return "unavailable";
  return "rejected";
}

const rpcResponse = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]),
  result: z.unknown().optional(),
  error: z.object({ code: z.number() }).loose().optional(),
});

const initializeResult = z.object({ protocolVersion: z.string().max(32) }).loose();
const listResult = z
  .object({
    tools: z.array(z.object({ name: z.string().min(1).max(128), inputSchema: z.unknown() }).loose()).max(200),
    nextCursor: z.string().max(512).optional(),
  })
  .loose();

export const callResult = z
  .object({
    content: z.array(z.object({ type: z.string() }).loose()).max(200).optional(),
    structuredContent: z.unknown().optional(),
    isError: z.boolean().optional(),
  })
  .loose();
export type CallResult = z.infer<typeof callResult>;

/** Feeds the body to `onChunk` until it returns true or the body ends. Throws `too_large` past `maxBytes`. */
async function readCapped(reader: ReadableStreamDefaultReader<Uint8Array>, maxBytes: number, onChunk: (text: string) => boolean): Promise<boolean> {
  const decoder = new TextDecoder();
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) {
      onChunk(decoder.decode());
      return true;
    }
    total += value.byteLength;
    if (total > maxBytes) throw new McpError("too_large");
    if (onChunk(decoder.decode(value, { stream: true }))) return true;
  }
}

/**
 * The JSON-RPC response with `id` from a JSON body or an SSE stream. For SSE it
 * stops at the first matching response, also when the server keeps the stream open.
 */
async function readResponse(response: Response, id: number, maxBytes: number): Promise<z.infer<typeof rpcResponse>> {
  if (!response.body) throw new McpError("bad_response");
  const reader = response.body.getReader();
  const type = response.headers.get("content-type") ?? "";
  try {
    if (type.includes("text/event-stream")) {
      let buffer = "";
      let found: z.infer<typeof rpcResponse> | null = null;
      const take = (event: string) => {
        const data = event
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, ""))
          .join("\n");
        if (!data) return;
        try {
          const parsed = rpcResponse.safeParse(JSON.parse(data));
          if (parsed.success && parsed.data.id === id && (parsed.data.result !== undefined || parsed.data.error)) found = parsed.data;
        } catch {
          // A server notification or a broken event; only the response counts.
        }
      };
      await readCapped(reader, maxBytes, (chunk) => {
        buffer += chunk;
        const events = buffer.split(/\r?\n\r?\n/);
        buffer = events.pop() ?? "";
        for (const event of events) {
          take(event);
          if (found) return true;
        }
        return false;
      });
      if (!found && buffer) take(buffer);
      if (!found) throw new McpError("bad_response");
      return found;
    }
    if (!type.includes("application/json")) throw new McpError("bad_response");
    let text = "";
    await readCapped(reader, maxBytes, (chunk) => {
      text += chunk;
      return false;
    });
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new McpError("bad_response");
    }
    const parsed = rpcResponse.safeParse(json);
    if (!parsed.success || parsed.data.id !== id) throw new McpError("bad_response");
    return parsed.data;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export interface McpSessionOptions {
  /** The MCP endpoint. The bearer token goes only to its origin. */
  url: string;
  fetch: FetchLike;
  /** A valid access token. `force` asks for a refresh after a 401. */
  token(force: boolean): Promise<string>;
  signal: AbortSignal;
}

export interface McpSession {
  /** The live definition of a tool, or null when the server does not list it. Listed once for each session. */
  pinOfTool(name: string): Promise<string | null>;
  callTool(name: string, args: Record<string, unknown>): Promise<CallResult>;
  listTools(): Promise<RemoteTool[]>;
  close(): void;
}

export function openMcpSession(options: McpSessionOptions): McpSession {
  const controller = new AbortController();
  let nextId = 1;
  let sessionId: string | null = null;
  let version: string = PROTOCOL_VERSION;
  let ready: Promise<void> | null = null;
  let listed: Promise<RemoteTool[]> | null = null;
  let forced = false;

  async function post(body: Record<string, unknown>, maxBytes: number, expectReply: boolean): Promise<z.infer<typeof rpcResponse> | null> {
    options.signal.throwIfAborted();
    controller.signal.throwIfAborted();
    const send = async (token: string) => {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
        "mcp-protocol-version": version,
      };
      if (sessionId) headers["mcp-session-id"] = sessionId;
      try {
        return await options.fetch(options.url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          redirect: "error",
          signal: AbortSignal.any([options.signal, controller.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
        });
      } catch (error) {
        const name = error instanceof Error ? error.name : "";
        if (options.signal.aborted) throw error;
        throw new McpError(name === "TimeoutError" || name === "AbortError" ? "timeout" : "unavailable");
      }
    };
    let response = await send(await options.token(false));
    if (response.status === 401 && !forced) {
      forced = true;
      await response.body?.cancel().catch(() => undefined);
      response = await send(await options.token(true));
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new McpError(kindFor(response.status), response.status);
    }
    const header = response.headers.get("mcp-session-id");
    if (header && /^[\x21-\x7e]{1,128}$/.test(header)) sessionId = header;
    if (!expectReply) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    try {
      return await readResponse(response, body.id as number, maxBytes);
    } catch (error) {
      if (options.signal.aborted) throw error;
      if (error instanceof McpError) throw error;
      const name = error instanceof Error ? error.name : "";
      throw new McpError(name === "TimeoutError" || name === "AbortError" ? "timeout" : "bad_response");
    }
  }

  async function request<T>(method: string, params: Record<string, unknown>, schema: z.ZodType<T>, maxBytes: number): Promise<T> {
    const reply = await post({ jsonrpc: "2.0", id: nextId++, method, params }, maxBytes, true);
    if (!reply || reply.error) throw new McpError("rejected");
    const parsed = schema.safeParse(reply.result);
    if (!parsed.success) throw new McpError("bad_response");
    return parsed.data;
  }

  function initialize(): Promise<void> {
    ready ??= (async () => {
      const result = await request(
        "initialize",
        { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "P-Dot", version: "1.0.0" } },
        initializeResult,
        MAX_INIT_BYTES,
      );
      if (!(SUPPORTED_VERSIONS as readonly string[]).includes(result.protocolVersion)) throw new McpError("rejected");
      version = result.protocolVersion;
      await post({ jsonrpc: "2.0", method: "notifications/initialized" }, MAX_INIT_BYTES, false);
    })();
    return ready;
  }

  async function listTools(): Promise<RemoteTool[]> {
    await initialize();
    listed ??= (async () => {
      const tools: RemoteTool[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
        const result = await request("tools/list", cursor ? { cursor } : {}, listResult, MAX_CALL_BYTES);
        tools.push(...result.tools.map((tool) => ({ name: tool.name, inputSchema: tool.inputSchema })));
        cursor = result.nextCursor;
        if (!cursor) break;
      }
      return tools;
    })();
    return listed;
  }

  return {
    listTools,
    async pinOfTool(name) {
      const tool = (await listTools()).find((candidate) => candidate.name === name);
      return tool ? pinOf(tool) : null;
    },
    async callTool(name, args) {
      await initialize();
      return request("tools/call", { name, arguments: args }, callResult, MAX_CALL_BYTES);
    },
    close() {
      controller.abort();
    },
  };
}
