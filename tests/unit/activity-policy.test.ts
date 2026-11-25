import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { listPrivateSourceActivity, mapPrivateSourceActivityRows } from "@/server/db/activity-policy";

describe("private-source Activity metadata", () => {
  it("projects only validated IDs, route reasons and timestamps", () => {
    const mapped = mapPrivateSourceActivityRows([
      {
        id: "00000000-0000-4000-8000-000000000001",
        route_reason: "connector_read",
        created_at: "2026-11-25T10:00:00.000Z",
        content: "private message text",
        conversation_id: "00000000-0000-4000-8000-000000000002",
      },
      { id: "invalid", route_reason: "everyday", created_at: "bad", content: "discarded" },
    ]);
    expect(mapped).toEqual([{
      id: "00000000-0000-4000-8000-000000000001",
      conversationId: "00000000-0000-4000-8000-000000000002",
      source: "connector_read",
      createdAt: "2026-11-25T10:00:00.000Z",
    }]);
    expect(JSON.stringify(mapped)).not.toContain("private message text");
  });

  it("scopes the read to the authenticated user and selects metadata columns only", async () => {
    const calls: unknown[][] = [];
    const query = {
      select: vi.fn((...args: unknown[]) => { calls.push(["select", ...args]); return query; }),
      eq: vi.fn((...args: unknown[]) => { calls.push(["eq", ...args]); return query; }),
      in: vi.fn((...args: unknown[]) => { calls.push(["in", ...args]); return query; }),
      order: vi.fn((...args: unknown[]) => { calls.push(["order", ...args]); return query; }),
      limit: vi.fn(async (...args: unknown[]) => {
        calls.push(["limit", ...args]);
        return { data: [{ id: "00000000-0000-4000-8000-000000000001", conversation_id: "00000000-0000-4000-8000-000000000002", route_reason: "google_request", created_at: "2026-11-25T10:00:00Z", content: "secret" }], error: null };
      }),
    };
    const supabase = { from: vi.fn(() => query) } as unknown as SupabaseClient;
    const entries = await listPrivateSourceActivity(supabase, "user-a", 20);
    expect(supabase.from).toHaveBeenCalledWith("messages");
    expect(calls).toContainEqual(["select", "id, conversation_id, route_reason, created_at"]);
    expect(calls).toContainEqual(["eq", "user_id", "user-a"]);
    expect(calls).toContainEqual(["eq", "role", "assistant"]);
    expect(calls).toContainEqual(["in", "route_reason", ["google_request", "connector_read"]]);
    expect(entries).toHaveLength(1);
    expect(JSON.stringify(entries)).not.toContain("secret");
  });
});
