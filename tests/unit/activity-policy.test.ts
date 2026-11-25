import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
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
      contains: vi.fn((...args: unknown[]) => { calls.push(["contains", ...args]); return query; }),
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
    expect(calls.filter(([method]) => method === "contains")).toHaveLength(3);
    expect(entries).toHaveLength(1);
    expect(JSON.stringify(entries)).not.toContain("secret");
  });
});
