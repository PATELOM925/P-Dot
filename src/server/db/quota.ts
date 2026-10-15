import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { RepositoryError } from "./conversations";

export interface QuotaDecision {
  allowed: boolean;
  resetsAt: Date;
}

/** Persistent per-user request limit, checked before any paid provider call. */
export interface QuotaGate {
  consume(): Promise<QuotaDecision>;
}

const quotaRow = z.object({
  allowed: z.boolean(),
  used: z.number().nullable(),
  resets_at: z.string(),
});

/**
 * Backed by the `consume_chat_quota` database function, which identifies the
 * caller from the session JWT (auth.uid()), so the user cannot be spoofed.
 * Fails closed: if the quota cannot be checked, the request is not served.
 */
export function createQuotaGate(
  supabase: SupabaseClient,
  limit: number,
  windowSeconds: number,
): QuotaGate {
  return {
    async consume() {
      const { data, error } = await supabase.rpc("consume_chat_quota", {
        p_limit: limit,
        p_window_seconds: windowSeconds,
      });
      if (error) throw new RepositoryError("consumeChatQuota");
      const row = quotaRow.safeParse(Array.isArray(data) ? data[0] : data);
      if (!row.success) throw new RepositoryError("consumeChatQuota");
      return { allowed: row.data.allowed, resetsAt: new Date(row.data.resets_at) };
    },
  };
}
