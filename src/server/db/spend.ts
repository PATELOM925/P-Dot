import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { RepositoryError } from "./conversations";

/** Nebius amounts are micro-dollars. Tavily amounts are credits. */
export type SpendProvider = "nebius" | "tavily";

/**
 * Which cap refused a reservation: `period` is the Nebius all-time cap or the
 * Tavily monthly cap, `day` is all users for the UTC day, `user` is this user
 * for the UTC day.
 */
export type SpendLimit = "period" | "day" | "user";

export type SpendReservation = { allowed: true; id: string } | { allowed: false; limit: SpendLimit };

export interface SpendCaps {
  day: number;
  period: number;
  userDay: number;
}

/** Global spending limits for paid providers, shared by all users. */
export interface SpendGuard {
  /** Holds `amount` if no cap would be passed. Call before the paid request. */
  reserve(provider: SpendProvider, amount: number): Promise<SpendReservation>;
  /** Records the real cost (0 to the held amount). Call after the paid request. */
  settle(reservationId: string, amount: number): Promise<void>;
}

const reserveRow = z.object({
  allowed: z.boolean(),
  reservation_id: z.string().nullable(),
  limit_hit: z.enum(["period", "day", "user"]).nullable(),
});

/**
 * Backed by the `reserve_provider_spend` and `settle_provider_spend` database
 * functions (see the global spend guard migration). Fails closed: if the
 * budget cannot be checked, `reserve` throws and the request is not served.
 */
export function createSpendGuard(
  supabase: SupabaseClient,
  caps: Record<SpendProvider, SpendCaps>,
): SpendGuard {
  return {
    async reserve(provider, amount) {
      const cap = caps[provider];
      const { data, error } = await supabase.rpc("reserve_provider_spend", {
        p_provider: provider,
        p_amount: amount,
        p_day_cap: cap.day,
        p_period_cap: cap.period,
        p_user_day_cap: cap.userDay,
      });
      if (error) throw new RepositoryError("reserveProviderSpend");
      const row = reserveRow.safeParse(Array.isArray(data) ? data[0] : data);
      if (!row.success) throw new RepositoryError("reserveProviderSpend");
      if (row.data.allowed && row.data.reservation_id) return { allowed: true, id: row.data.reservation_id };
      if (!row.data.allowed && row.data.limit_hit) return { allowed: false, limit: row.data.limit_hit };
      throw new RepositoryError("reserveProviderSpend");
    },
    async settle(reservationId, amount) {
      const { error } = await supabase.rpc("settle_provider_spend", {
        p_reservation: reservationId,
        p_amount: amount,
      });
      if (error) throw new RepositoryError("settleProviderSpend");
    },
  };
}
