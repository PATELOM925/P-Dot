import { describe, expect, it } from "vitest";
import { MCP_SERVERS } from "@/server/mcp/catalog";
import { McpError, openMcpSession } from "@/server/mcp/client";
import { fakeApp, POISON } from "../support/fake-mcp";

const notion = MCP_SERVERS.notion;

function session(app: ReturnType<typeof fakeApp>, token: (force: boolean) => Promise<string>, signal = new AbortController().signal) {
  return openMcpSession({ url: notion.resource, fetch: app.fetch, token, signal });
}

describe("MCP client", () => {
  it.each(["json", "sse"] as const)("initializes, lists and calls a tool over %s", async (mode) => {
    const app = fakeApp("notion", { mode });
    const access = app.grant().access_token;
    app.onCall((name, args) => ({ content: [{ type: "text", text: `${name}:${JSON.stringify(args)}` }] }));
    const s = session(app, async () => access);
    const result = await s.callTool("notion-search", { query: "plan" });
    expect(result.content).toEqual([{ type: "text", text: 'notion-search:{"query":"plan"}' }]);
    expect((await s.listTools()).map((tool) => tool.name)).toContain("notion-fetch");
    const methods = app.mcpCalls().map((call) => (JSON.parse(call.body) as { method: string }).method);
    expect(methods).toEqual(["initialize", "notifications/initialized", "tools/call", "tools/list"]);
    expect(app.mcpCalls().every((call) => call.method === "POST")).toBe(true);
    expect(app.mcpCalls().slice(1).every((call) => call.headers["mcp-session-id"] === "session-1")).toBe(true);
    expect(app.mcpCalls().every((call) => call.headers["mcp-protocol-version"] === "2025-06-18")).toBe(true);
    if (mode === "sse") {
      expect(app.openStreams.length).toBeGreaterThan(0);
      expect(app.openStreams.every((stream) => stream.cancelled)).toBe(true);
    }
    s.close();
  });

  it("never puts the server's instructions or definitions anywhere but the pin", async () => {
    const app = fakeApp("notion");
    const access = app.grant().access_token;
    const s = session(app, async () => access);
    const pin = await s.pinOfTool("notion-search");
    expect(pin).toMatch(/^[0-9a-f]{64}$/);
    expect(pin).not.toContain(POISON);
    expect(await s.pinOfTool("not-a-tool")).toBeNull();
  });

  it("refreshes once after a 401 and retries the request once", async () => {
    const app = fakeApp("notion");
    const fresh = app.grant().access_token;
    const forced: boolean[] = [];
    let current = "stale-token";
    const s = session(app, async (force) => {
      forced.push(force);
      if (force) current = fresh;
      return current;
    });
    await s.callTool("notion-search", { query: "x" });
    expect(forced).toEqual([false, true, false, false]);
    app.expireAccess();
    await expect(s.callTool("notion-search", { query: "x" })).rejects.toMatchObject({ kind: "unauthorized" });
  });

  it("answers an error class for each failure, and no retry of a call", async () => {
    const app = fakeApp("notion");
    const access = app.grant().access_token;
    const s = session(app, async () => access);
    await s.callTool("notion-search", { query: "x" });
    const before = app.toolCalls().length;
    app.failMcp(503);
    await expect(s.callTool("notion-search", { query: "x" })).rejects.toMatchObject({ kind: "unavailable" });
    app.failMcp(403);
    await expect(s.callTool("notion-search", { query: "x" })).rejects.toMatchObject({ kind: "forbidden" });
    app.failMcp(null);
    expect(app.toolCalls().length).toBe(before + 2);
  });

  it("stops a body that is larger than the cap and cancels it", async () => {
    const app = fakeApp("notion");
    const access = app.grant().access_token;
    let cancelled = false;
    app.onCall(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.enqueue(new Uint8Array(64 * 1024).fill(32));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const s = session(app, async () => access);
    await expect(s.callTool("notion-search", { query: "x" })).rejects.toMatchObject({ kind: "too_large" });
    expect(cancelled).toBe(true);
  });

  it("refuses an unknown protocol version, a bad body and a JSON-RPC error", async () => {
    const versions = fakeApp("notion");
    const token = versions.grant().access_token;
    const bad = openMcpSession({
      url: notion.resource,
      signal: new AbortController().signal,
      token: async () => token,
      fetch: async (url, init) => {
        const body = JSON.parse(String(init?.body)) as { id: number; method: string };
        if (body.method === "initialize") {
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "1999-01-01" } }), {
            headers: { "content-type": "application/json" },
          });
        }
        return versions.fetch(url, init);
      },
    });
    await expect(bad.callTool("notion-search", { query: "x" })).rejects.toBeInstanceOf(McpError);

    const app = fakeApp("notion");
    const access = app.grant().access_token;
    app.onCall(() => new Response("not json", { headers: { "content-type": "application/json" } }));
    await expect(session(app, async () => access).callTool("notion-search", { query: "x" })).rejects.toMatchObject({ kind: "bad_response" });
    app.onCall(() => new Response("<html>", { headers: { "content-type": "text/html" } }));
    await expect(session(app, async () => access).callTool("notion-search", { query: "x" })).rejects.toMatchObject({ kind: "bad_response" });
  });

  it("sends the bearer token only to the resource, with redirects refused, and stops on Stop", async () => {
    const app = fakeApp("notion");
    const access = app.grant().access_token;
    const seen: RequestInit[] = [];
    const controller = new AbortController();
    const s = openMcpSession({
      url: notion.resource,
      signal: controller.signal,
      token: async () => access,
      fetch: async (url, init) => {
        expect(url).toBe(notion.resource);
        seen.push(init!);
        return app.fetch(url, init);
      },
    });
    await s.callTool("notion-search", { query: "x" });
    expect(seen.every((init) => init.redirect === "manual")).toBe(true);
    controller.abort();
    await expect(s.callTool("notion-search", { query: "x" })).rejects.toThrow();
  });
});
