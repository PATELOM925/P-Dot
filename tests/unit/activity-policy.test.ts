import { describe, expect, it, vi } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { PGlite } from "@electric-sql/pglite";
import { listPrivateSourceActivity, mapPrivateSourceActivityRows } from "@/server/db/activity-policy";

describe("private-source Activity metadata", () => {
  it("projects only validated outcome metadata, excluding selected-only routing markers and content", () => {
    const mapped = mapPrivateSourceActivityRows([
      {
        id: "00000000-0000-4000-8000-000000000001",
        sources: [{ title: "private page", url: "https://private.example/secret" }, { __pdot_activity: { kind: "connector_read_succeeded", source: "connector" } }],
        created_at: "2026-11-25T10:00:00.000Z",
        content: "private message text",
        conversation_id: "00000000-0000-4000-8000-000000000002",
      },
      { id: "00000000-0000-4000-8000-000000000003", sources: [], route_reason: "connector_read", created_at: "2026-11-25T10:00:00.000Z", conversation_id: "00000000-0000-4000-8000-000000000002" },
      { id: "00000000-0000-4000-8000-000000000004", sources: [{ __pdot_activity: { kind: "assistant_search_blocked", source: "assistant_search" } }], created_at: "2026-11-25T10:01:00.000Z", conversation_id: "00000000-0000-4000-8000-000000000002" },
      { id: "invalid", sources: [], created_at: "bad", content: "discarded" },
    ]);
    expect(mapped).toEqual([
      { id: "00000000-0000-4000-8000-000000000001:0", conversationId: "00000000-0000-4000-8000-000000000002", source: "connector", outcome: "read_succeeded", createdAt: "2026-11-25T10:00:00.000Z" },
      { id: "00000000-0000-4000-8000-000000000004:0", conversationId: "00000000-0000-4000-8000-000000000002", source: "assistant_search", outcome: "search_blocked", createdAt: "2026-11-25T10:01:00.000Z" },
    ]);
    expect(JSON.stringify(mapped)).not.toContain("private message text");
  });

  it("scopes the read to the authenticated user and selects metadata columns only", async () => {
    const calls: unknown[][] = [];
    let reads = 0;
    const query = {
      select: vi.fn((...args: unknown[]) => { calls.push(["select", ...args]); return query; }),
      eq: vi.fn((...args: unknown[]) => { calls.push(["eq", ...args]); return query; }),
      in: vi.fn((...args: unknown[]) => { calls.push(["in", ...args]); return query; }),
      filter: vi.fn((...args: unknown[]) => { calls.push(["filter", ...args]); return query; }),
      order: vi.fn((...args: unknown[]) => { calls.push(["order", ...args]); return query; }),
      limit: vi.fn(async (...args: unknown[]) => {
        calls.push(["limit", ...args]);
        reads += 1;
        return { data: reads === 1 ? [{ id: "00000000-0000-4000-8000-000000000001", conversation_id: "00000000-0000-4000-8000-000000000002", sources: [{ __pdot_activity: { kind: "connector_read_succeeded", source: "google" } }], created_at: "2026-11-25T10:00:00Z", content: "secret" }] : [], error: null };
      }),
    };
    const supabase = { from: vi.fn(() => query) } as unknown as SupabaseClient;
    const entries = await listPrivateSourceActivity(supabase, "user-a", 20);
    expect(supabase.from).toHaveBeenCalledWith("messages");
    expect(calls).toContainEqual(["select", "id, conversation_id, sources, created_at"]);
    expect(calls).toContainEqual(["eq", "user_id", "user-a"]);
    expect(calls).toContainEqual(["eq", "role", "assistant"]);
    expect(calls.filter(([method]) => method === "filter")).toHaveLength(3);
    expect(entries).toHaveLength(1);
    expect(JSON.stringify(entries)).not.toContain("secret");
  });

  it("uses the pinned Supabase request builder with valid JSONB filters and deduplicates overlapping rows", async () => {
    const pg = await PGlite.create();
    const sources = [
      { __pdot_activity: { kind: "connector_read_succeeded", source: "google" } },
      { __pdot_activity: { kind: "assistant_search_blocked", source: "assistant_search" } },
    ];
    const oldSources = [{ __pdot_activity: { kind: "connector_read_succeeded", source: "connector" } }];
    const allRows = [
      { id: "00000000-0000-4000-8000-000000000001", conversation_id: "00000000-0000-4000-8000-000000000002", sources, created_at: "2026-11-25T10:02:00Z" },
      { id: "00000000-0000-4000-8000-000000000003", conversation_id: "00000000-0000-4000-8000-000000000002", sources: oldSources, created_at: "2026-11-25T10:01:00Z" },
      { id: "00000000-0000-4000-8000-000000000004", conversation_id: "00000000-0000-4000-8000-000000000002", sources: [], created_at: "2026-11-25T10:00:00Z" },
    ];
    const requests: URL[] = [];
    const client = createClient("http://supabase.test", "publishable-test-key", {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: async (input) => {
        const url = new URL(String(input));
        requests.push(url);
        const encoded = url.searchParams.get("sources");
        if (!encoded?.startsWith("cs.")) return new Response(JSON.stringify({ message: "missing contains filter" }), { status: 400 });
        const operand = encoded.slice(3);
        let matched: typeof allRows;
        try {
          const matches = await Promise.all(allRows.map(async (row) => {
            const result = await pg.query<{ matches: boolean }>("select $1::jsonb @> $2::jsonb as matches", [JSON.stringify(row.sources), operand]);
            return result.rows[0]?.matches ? row : null;
          }));
          matched = matches.filter((row): row is typeof allRows[number] => row !== null);
        } catch {
          return new Response(JSON.stringify({ message: "invalid jsonb operand" }), { status: 400 });
        }
        const response = matched.sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, Number(url.searchParams.get("limit")));
        return new Response(JSON.stringify(response), { status: 200, headers: { "content-type": "application/json" } });
      } },
    });

    const entries = await listPrivateSourceActivity(client, "user-a", 3);
    expect(requests).toHaveLength(3);
    for (const request of requests) {
      const encoded = request.searchParams.get("sources")!;
      expect(encoded.startsWith("cs.")).toBe(true);
      expect(() => JSON.parse(encoded.slice(3))).not.toThrow();
    }
    expect(entries).toEqual([
      { id: "00000000-0000-4000-8000-000000000001:0", conversationId: "00000000-0000-4000-8000-000000000002", source: "google", outcome: "read_succeeded", createdAt: "2026-11-25T10:02:00Z" },
      { id: "00000000-0000-4000-8000-000000000001:1", conversationId: "00000000-0000-4000-8000-000000000002", source: "assistant_search", outcome: "search_blocked", createdAt: "2026-11-25T10:02:00Z" },
      { id: "00000000-0000-4000-8000-000000000003:0", conversationId: "00000000-0000-4000-8000-000000000002", source: "connector", outcome: "read_succeeded", createdAt: "2026-11-25T10:01:00Z" },
    ]);
    await pg.close();
  });
});
