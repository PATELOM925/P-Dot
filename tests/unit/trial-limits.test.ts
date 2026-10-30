import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAssistantDeps, createEmbedderForRequest } from "@/server/assistant/deps";
import { getAssistantConfig } from "@/server/config";
import { TRIAL_LIMITS, limitsFor } from "@/server/trial-limits";

const config = getAssistantConfig({ NEBIUS_API_KEY: "k", NODE_ENV: "test" });

/** A Supabase client that records each RPC and answers "allowed". */
function recordingClient() {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const rpc = vi.fn(async (fn: string, args: Record<string, unknown>) => {
    calls.push({ fn, args });
    if (fn === "consume_chat_quota") return { data: { allowed: true, used: 1, resets_at: new Date().toISOString() }, error: null };
    return { data: { allowed: true, reservation_id: "r1", limit_hit: null }, error: null };
  });
  return { calls, supabase: { rpc } as unknown as SupabaseClient };
}

describe("limitsFor", () => {
  it("keeps the account limits for an account", () => {
    expect(limitsFor({ isAnonymous: false }, config)).toEqual({ quota: config.quota, spend: config.spend });
  });

  it("lowers only the per-user limits for a trial, and keeps the global caps", () => {
    const trial = limitsFor({ isAnonymous: true }, config);
    expect(trial.quota.requestsPerWindow).toBe(Math.min(config.quota.requestsPerWindow, TRIAL_LIMITS.requestsPerWindow));
    expect(trial.quota.windowSeconds).toBe(config.quota.windowSeconds);
    expect(trial.spend.nebius).toEqual({ ...config.spend.nebius, userDay: TRIAL_LIMITS.nebiusUserDayMicroUsd });
    expect(trial.spend.tavily).toEqual({ ...config.spend.tavily, userDay: TRIAL_LIMITS.tavilyUserDayCredits });
    expect(trial.spend.nebius.userDay).toBeLessThan(config.spend.nebius.userDay);
  });

  it("never raises a limit that the account config sets lower", () => {
    const low = { ...config, quota: { ...config.quota, requestsPerWindow: 5 } };
    expect(limitsFor({ isAnonymous: true }, low).quota.requestsPerWindow).toBe(5);
  });

  it("gives the trial limits to a context without the flag", () => {
    expect(limitsFor({}, config).spend.nebius.userDay).toBe(TRIAL_LIMITS.nebiusUserDayMicroUsd);
  });
});

describe("Google tools for a trial (decision 0014)", () => {
  it("gives a trial no Google services, also when Google is set up; an account gets them", () => {
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "id");
    vi.stubEnv("GOOGLE_OAUTH_CLIENT_SECRET", "secret");
    vi.stubEnv("GOOGLE_TOKEN_ENCRYPTION_KEY", Buffer.from(new Uint8Array(32).fill(1)).toString("base64"));
    try {
      const { supabase } = recordingClient();
      const trial = createAssistantDeps({ userId: "u", email: null, isAnonymous: true, supabase }, config);
      expect(trial.google).toBeNull();
      expect(trial.googleBlocked).toBe("demo_session");
      const unknown = createAssistantDeps({ userId: "u", email: null, supabase }, config);
      expect(unknown.google).toBeNull();
      const account = createAssistantDeps({ userId: "u", email: "a@example.com", isAnonymous: false, supabase }, config);
      expect(account.google).not.toBeNull();
      expect(account.googleBlocked).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("trial limits reach the database calls", () => {
  it("sends the trial caps to the quota and spend functions for chat", async () => {
    const { calls, supabase } = recordingClient();
    const deps = createAssistantDeps({ userId: "u", email: null, isAnonymous: true, supabase }, config);
    await deps.quota.consume();
    await deps.spend.reserve("nebius", 10);
    await deps.spend.reserve("tavily", 1);
    expect(calls[0]).toMatchObject({ fn: "consume_chat_quota", args: { p_limit: TRIAL_LIMITS.requestsPerWindow } });
    expect(calls[1]).toMatchObject({
      fn: "reserve_provider_spend",
      args: { p_amount: 10, p_user_day_cap: TRIAL_LIMITS.nebiusUserDayMicroUsd, p_day_cap: config.spend.nebius.day },
    });
    expect(calls[2]).toMatchObject({ args: { p_user_day_cap: TRIAL_LIMITS.tavilyUserDayCredits } });
  });

  it("sends the trial cap for embeddings", async () => {
    const { calls, supabase } = recordingClient();
    const embedder = createEmbedderForRequest({ userId: "u", email: null, isAnonymous: true, supabase }, config);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
    await embedder.embed(["hi"]).catch(() => undefined);
    vi.unstubAllGlobals();
    expect(calls.find((c) => c.fn === "reserve_provider_spend")?.args.p_user_day_cap).toBe(TRIAL_LIMITS.nebiusUserDayMicroUsd);
  });

  it("sends the trial cap for the retrieval embeddings of a chat turn", async () => {
    const { calls, supabase } = recordingClient();
    const deps = createAssistantDeps({ userId: "u", email: null, isAnonymous: true, supabase }, config);
    expect(deps.ownData).toBeTruthy();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
    await deps.ownData!.embedder.embed(["hi"], new AbortController().signal).catch(() => undefined);
    vi.unstubAllGlobals();
    expect(calls.find((c) => c.fn === "reserve_provider_spend")?.args.p_user_day_cap).toBe(TRIAL_LIMITS.nebiusUserDayMicroUsd);
  });

  it("sends the account caps for an account", async () => {
    const { calls, supabase } = recordingClient();
    const deps = createAssistantDeps({ userId: "u", email: "a@example.com", isAnonymous: false, supabase }, config);
    await deps.spend.reserve("nebius", 10);
    expect(calls[0]!.args.p_user_day_cap).toBe(config.spend.nebius.userDay);
  });
});
