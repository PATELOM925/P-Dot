import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { ActionLogEntryDTO, ActionLogEvent } from "@/types/api";
import { RepositoryError } from "./conversations";

/** Values allowed in a log entry's detail: IDs, kinds, counts and flags. Never message or memory text. */
export type LogDetail = Record<string, string | number | boolean | null>;

/** Append-only action log (decision 0009). The table refuses updates and deletes. */
export interface ActionLogRepository {
  append(userId: string, event: ActionLogEvent, detail?: LogDetail, proposalId?: string | null): Promise<void>;
  list(userId: string, limit: number): Promise<ActionLogEntryDTO[]>;
}

const MAX_DETAIL_STRING = 200;

/** Drops long strings, so text cannot be logged by mistake. */
function safeDetail(detail: LogDetail): LogDetail {
  const out: LogDetail = {};
  for (const [key, value] of Object.entries(detail)) {
    out[key] = typeof value === "string" && value.length > MAX_DETAIL_STRING ? null : value;
  }
  return out;
}

const logRow = z.object({
  id: z.string(),
  proposal_id: z.string().nullable(),
  event: z.string(),
  detail: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  created_at: z.string(),
});

export function createActionLogRepository(supabase: SupabaseClient): ActionLogRepository {
  return {
    async append(userId, event, detail = {}, proposalId = null) {
      const { error } = await supabase
        .from("action_log")
        .insert({ user_id: userId, event, detail: safeDetail(detail), proposal_id: proposalId });
      if (error) throw new RepositoryError("appendActionLog");
    },
    async list(userId, limit) {
      const { data, error } = await supabase
        .from("action_log")
        .select("id, proposal_id, event, detail, created_at")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) throw new RepositoryError("listActionLog");
      return (data ?? []).map((row) => {
        const r = logRow.parse(row);
        return {
          id: r.id,
          proposalId: r.proposal_id,
          event: r.event as ActionLogEvent,
          detail: r.detail,
          createdAt: r.created_at,
        };
      });
    },
  };
}
