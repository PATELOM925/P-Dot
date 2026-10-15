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
    const conversation = await repoA.createConversation(a.userId, "RLS test (safe to delete)");
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
    const updated = await b.client.from("conversations").update({ title: "pwned" }).eq("id", conversationId);
    expect(updated.error).not.toBeNull();
    const stillThere = await createConversationRepository(a.client).getConversation(a.userId, conversationId);
    expect(stillThere?.title).toBe("RLS test (safe to delete)");
  });

  it("enforces the usage quota per user", async () => {
    const first = await a.client.rpc("consume_chat_quota", { p_limit: 1_000_000, p_window_seconds: 60 });
    expect(first.error).toBeNull();
    expect(first.data?.[0]?.allowed).toBe(true);
    const direct = await a.client.from("usage_windows").update({ request_count: 0 }).eq("user_id", a.userId);
    expect(direct.error).not.toBeNull();
  });
});
