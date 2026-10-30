import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { RepositoryError, SchemaMissingError } from "./conversations";

export interface NewFeedback {
  kind: string;
  text: string | null;
}

export type FeedbackResult = "sent" | "rate_limited";

export interface FeedbackRepository {
  send(feedback: NewFeedback): Promise<FeedbackResult>;
}

/** SQLSTATE of the daily cap in the feedback_requests trigger. */
const LIMIT_REACHED = "54000";
const TABLE_MISSING = new Set(["42P01", "PGRST205"]);

/**
 * Feedback requests. The insert sends only kind and text: the database fills
 * in the user from the session and refuses a user_id from the client.
 */
export function createFeedbackRepository(supabase: SupabaseClient): FeedbackRepository {
  return {
    async send({ kind, text }) {
      const { error } = await supabase.from("feedback_requests").insert({ kind, text });
      if (!error) return "sent";
      if (error.code === LIMIT_REACHED) return "rate_limited";
      if (error.code && TABLE_MISSING.has(error.code)) throw new SchemaMissingError("sendFeedback");
      throw new RepositoryError("sendFeedback");
    },
  };
}
