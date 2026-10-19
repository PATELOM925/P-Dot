import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createConversationRepository } from "@/server/db/conversations";

/**
 * Verifies row-level security against a real Supabase project with the
 * migration applied. Skipped unless these variables are set (use a test
 * project, never production):
 *
 *   SUPABASE_TEST_URL, SUPABASE_TEST_PUBLISHABLE_KEY,
 *   SUPABASE_TEST_USER_A_EMAIL, SUPABASE_TEST_USER_A_PASSWORD,
 *   SUPABASE_TEST_USER_B_EMAIL, SUPABASE_TEST_USER_B_PASSWORD
 *
 * Both users must already exist and be confirmed. Only the publishable key is
 * used, exactly like the app.
 */
const env = process.env;
const configured = Boolean(
  env.SUPABASE_TEST_URL &&
    env.SUPABASE_TEST_PUBLISHABLE_KEY &&
    env.SUPABASE_TEST_USER_A_EMAIL &&
    env.SUPABASE_TEST_USER_A_PASSWORD &&
    env.SUPABASE_TEST_USER_B_EMAIL &&
    env.SUPABASE_TEST_USER_B_PASSWORD,
);

async function signIn(email: string, password: string): Promise<{ client: SupabaseClient; userId: string }> {
  const client = createClient(env.SUPABASE_TEST_URL!, env.SUPABASE_TEST_PUBLISHABLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.user) throw new Error("Test user sign-in failed");
  return { client, userId: data.user.id };
}

describe.skipIf(!configured)("row-level security (live Supabase)", () => {
  let a: Awaited<ReturnType<typeof signIn>>;
  let b: Awaited<ReturnType<typeof signIn>>;
  let conversationId: string;

  beforeAll(async () => {
    a = await signIn(env.SUPABASE_TEST_USER_A_EMAIL!, env.SUPABASE_TEST_USER_A_PASSWORD!);
    b = await signIn(env.SUPABASE_TEST_USER_B_EMAIL!, env.SUPABASE_TEST_USER_B_PASSWORD!);
    const repoA = createConversationRepository(a.client);
    const conversation = await repoA.createConversation(a.userId, "RLS test (safe to delete)", "personal");
    conversationId = conversation.id;
    await repoA.insertMessage(a.userId, { conversationId, role: "user", content: "private" });
  });

  afterAll(async () => {
    if (conversationId) await createConversationRepository(a.client).deleteConversation(a.userId, conversationId);
  });

  it("does not let user B read user A's conversation or messages, even by ID", async () => {
    const conversations = await b.client.from("conversations").select("id").eq("id", conversationId);
    expect(conversations.data).toEqual([]);
    const messages = await b.client.from("messages").select("id").eq("conversation_id", conversationId);
    expect(messages.data).toEqual([]);
  });

  it("does not let user B write into user A's conversation", async () => {
    const asSelf = await b.client
      .from("messages")
      .insert({ conversation_id: conversationId, user_id: b.userId, role: "user", content: "intrusion" });
    expect(asSelf.error).not.toBeNull();
    const impersonating = await b.client
      .from("messages")
      .insert({ conversation_id: conversationId, user_id: a.userId, role: "user", content: "intrusion" });
    expect(impersonating.error).not.toBeNull();
  });

  it("does not let user B delete or modify user A's conversation", async () => {
    const deleted = await b.client.from("conversations").delete({ count: "exact" }).eq("id", conversationId);
    expect(deleted.count ?? 0).toBe(0);
    // Titles are updatable by their owner now; RLS must make this a no-op for anyone else.
    const updated = await b.client.from("conversations").update({ title: "pwned" }).eq("id", conversationId).select("id");
    expect(updated.data ?? []).toEqual([]);
    const stillThere = await createConversationRepository(a.client).getConversation(a.userId, conversationId);
    expect(stillThere?.title).toBe("RLS test (safe to delete)");
  });

  it("stores the route of a reply privately and only on assistant messages", async () => {
    const repoA = createConversationRepository(a.client);
    const route = { model: "nvidia/nemotron-3-super-120b-a12b", tier: "standard" as const, reason: "analysis" as const, fallback: true };
    const saved = await repoA.insertMessage(a.userId, { conversationId, role: "assistant", content: "routed reply", route });
    expect(saved.route).toEqual(route);
    const [userMessage] = await repoA.listRecentMessages(a.userId, conversationId, 1_000);
    expect(userMessage!.route).toBeNull();

    const seen = await b.client.from("messages").select("model").eq("id", saved.id);
    expect(seen.data).toEqual([]);
    const onUserMessage = await a.client
      .from("messages")
      .insert({ conversation_id: conversationId, user_id: a.userId, role: "user", content: "x", model: "m/x" });
    expect(onUserMessage.error).not.toBeNull();
    const badTier = await a.client
      .from("messages")
      .insert({ conversation_id: conversationId, user_id: a.userId, role: "assistant", content: "x", model_tier: "warp" });
    expect(badTier.error).not.toBeNull();
    const changed = await a.client.from("messages").update({ model: "m/y" }).eq("id", saved.id);
    expect(changed.error).not.toBeNull();
  });

  it("enforces the usage quota per user", async () => {
    const first = await a.client.rpc("consume_chat_quota", { p_limit: 1_000_000, p_window_seconds: 60 });
    expect(first.error).toBeNull();
    expect(first.data?.[0]?.allowed).toBe(true);
    const direct = await a.client.from("usage_windows").update({ request_count: 0 }).eq("user_id", a.userId);
    expect(direct.error).not.toBeNull();
  });

  // Uses tiny amounts and gives them back, so the test project's counters barely move.
  describe("global spend guard", () => {
    const caps = { p_day_cap: 1_000_000, p_period_cap: 20_000_000, p_user_day_cap: 250_000 };
    const reserve = (client: SupabaseClient, amount: number) =>
      client.rpc("reserve_provider_spend", { p_provider: "nebius", p_amount: amount, ...caps });

    it("does not let a user read or write the spend tables directly", async () => {
      for (const [table, change] of [
        ["spend_counters", { used: 0 }],
        ["spend_reservations", { charged: 0 }],
      ] as const) {
        const read = await a.client.from(table).select("*").limit(1);
        expect(read.error).not.toBeNull();
        const update = await a.client.from(table).update(change).neq("provider", "");
        expect(update.error).not.toBeNull();
        const remove = await a.client.from(table).delete().neq("provider", "");
        expect(remove.error).not.toBeNull();
      }
      const insert = await a.client
        .from("spend_counters")
        .insert({ provider: "nebius", period_kind: "day", period_start: "2001-01-01", used: 0 });
      expect(insert.error).not.toBeNull();
    });

    it("does not let a user lower the totals through the functions", async () => {
      const held = await reserve(a.client, 3);
      expect(held.error).toBeNull();
      expect(held.data?.[0]?.allowed).toBe(true);
      const id = held.data?.[0]?.reservation_id as string;

      // Negative and above-hold amounts are rejected.
      expect((await a.client.rpc("settle_provider_spend", { p_reservation: id, p_amount: -1_000_000 })).error).not.toBeNull();
      expect((await a.client.rpc("settle_provider_spend", { p_reservation: id, p_amount: 4 })).error).not.toBeNull();
      // Another user cannot settle it.
      expect((await b.client.rpc("settle_provider_spend", { p_reservation: id, p_amount: 0 })).data).toBe(false);
      // The owner can settle it once, and only down to 0 of its own hold.
      expect((await a.client.rpc("settle_provider_spend", { p_reservation: id, p_amount: 0 })).data).toBe(true);
      expect((await a.client.rpc("settle_provider_spend", { p_reservation: id, p_amount: 0 })).data).toBe(false);
    });

    it("rejects out-of-bound caps and amounts", async () => {
      expect((await reserve(a.client, 0)).error).not.toBeNull();
      expect((await reserve(a.client, 250_001)).error).not.toBeNull();
      const bigCap = await a.client.rpc("reserve_provider_spend", {
        p_provider: "nebius",
        p_amount: 1,
        p_day_cap: 1_000_000,
        p_period_cap: 20_000_000,
        p_user_day_cap: 500_001,
      });
      expect(bigCap.error).not.toBeNull();
    });
  });

  it("lets a user rename only their own conversation, and change nothing else", async () => {
    const repoA = createConversationRepository(a.client);
    const renamed = await repoA.renameConversation(a.userId, conversationId, "Renamed by owner");
    expect(renamed?.title).toBe("Renamed by owner");

    const byOther = await createConversationRepository(b.client).renameConversation(b.userId, conversationId, "pwned");
    expect(byOther).toBeNull();

    const otherColumns = await a.client.from("conversations").update({ mode: "work" }).eq("id", conversationId);
    expect(otherColumns.error).not.toBeNull();
  });

  it("keeps tasks private to their owner", async () => {
    const created = await a.client
      .from("tasks")
      .insert({ user_id: a.userId, mode: "work", title: "RLS task (safe to delete)" })
      .select("id")
      .single();
    expect(created.error).toBeNull();
    const taskId = created.data!.id as string;

    const seen = await b.client.from("tasks").select("id").eq("id", taskId);
    expect(seen.data).toEqual([]);
    const changed = await b.client.from("tasks").update({ done: true }).eq("id", taskId).select("id");
    expect(changed.data).toEqual([]);
    const removed = await b.client.from("tasks").delete({ count: "exact" }).eq("id", taskId);
    expect(removed.count ?? 0).toBe(0);
    const impersonated = await b.client.from("tasks").insert({ user_id: a.userId, mode: "work", title: "x" });
    expect(impersonated.error).not.toBeNull();

    const cleanup = await a.client.from("tasks").delete({ count: "exact" }).eq("id", taskId);
    expect(cleanup.count).toBe(1);
  });
});
