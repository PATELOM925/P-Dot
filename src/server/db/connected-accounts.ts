import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { DATA_SCOPES, type DataScope } from "@/server/google/oauth";
import { RepositoryError } from "./conversations";

/**
 * Connected accounts (decision 0014). One row for each user and provider,
 * under RLS. Only `getGoogleToken` selects the ciphertext; the status that
 * the screens use never contains it.
 */
export type ConnectionStatus = "connected" | "needs_reconnect";

export interface GoogleConnection {
  email: string;
  scopes: DataScope[];
  status: ConnectionStatus;
}

export interface GoogleTokenRow extends GoogleConnection {
  /** Google's `sub`. An external action runs only in the account it was claimed for. */
  subject: string;
  tokenCiphertext: string;
}

export interface ConnectedAccountRepository {
  getGoogleConnection(userId: string): Promise<GoogleConnection | null>;
  getGoogleToken(userId: string): Promise<GoogleTokenRow | null>;
  /** Inserts or replaces the caller's Google row and marks it connected (one statement). */
  saveGoogle(subject: string, email: string, scopes: DataScope[], tokenCiphertext: string): Promise<void>;
  /** Only while the row still has this ciphertext, so a newer connection is not overwritten. */
  markGoogleNeedsReconnect(userId: string, tokenCiphertext: string): Promise<void>;
  /** True when a row was deleted. */
  deleteGoogle(userId: string): Promise<boolean>;
}

const STATUS_COLUMNS = "account_email, scopes, status";

const statusRow = z.object({
  account_email: z.string(),
  scopes: z.array(z.string()),
  status: z.enum(["connected", "needs_reconnect"]),
});
const tokenRow = statusRow.extend({ account_subject: z.string(), token_ciphertext: z.string() });

const knownScopes = (scopes: string[]) => DATA_SCOPES.filter((scope) => scopes.includes(scope));

function toConnection(row: z.infer<typeof statusRow>): GoogleConnection {
  return { email: row.account_email, scopes: knownScopes(row.scopes), status: row.status };
}

export function createConnectedAccountRepository(supabase: SupabaseClient): ConnectedAccountRepository {
  return {
    async getGoogleConnection(userId) {
      const { data, error } = await supabase
        .from("connected_accounts")
        .select(STATUS_COLUMNS)
        .eq("user_id", userId)
        .eq("provider", "google")
        .maybeSingle();
      if (error) throw new RepositoryError("getGoogleConnection");
      if (!data) return null;
      const parsed = statusRow.safeParse(data);
      if (!parsed.success) throw new RepositoryError("getGoogleConnection");
      return toConnection(parsed.data);
    },

    async getGoogleToken(userId) {
      const { data, error } = await supabase
        .from("connected_accounts")
        .select(`${STATUS_COLUMNS}, account_subject, token_ciphertext`)
        .eq("user_id", userId)
        .eq("provider", "google")
        .maybeSingle();
      if (error) throw new RepositoryError("getGoogleToken");
      if (!data) return null;
      const parsed = tokenRow.safeParse(data);
      if (!parsed.success) throw new RepositoryError("getGoogleToken");
      return {
        ...toConnection(parsed.data),
        subject: parsed.data.account_subject,
        tokenCiphertext: parsed.data.token_ciphertext,
      };
    },

    async saveGoogle(subject, email, scopes, tokenCiphertext) {
      const { error } = await supabase.rpc("save_connected_account", {
        p_provider: "google",
        p_account_subject: subject,
        p_account_email: email,
        p_scopes: scopes,
        p_token_ciphertext: tokenCiphertext,
      });
      if (error) throw new RepositoryError("saveConnectedAccount");
    },

    async markGoogleNeedsReconnect(userId, tokenCiphertext) {
      const { error } = await supabase
        .from("connected_accounts")
        .update({ status: "needs_reconnect" })
        .eq("user_id", userId)
        .eq("provider", "google")
        .eq("token_ciphertext", tokenCiphertext)
        .select("status");
      if (error) throw new RepositoryError("markGoogleNeedsReconnect");
    },

    async deleteGoogle(userId) {
      const { data, error } = await supabase
        .from("connected_accounts")
        .delete()
        .eq("user_id", userId)
        .eq("provider", "google")
        .select("provider");
      if (error) throw new RepositoryError("deleteGoogle");
      return Array.isArray(data) && data.length > 0;
    },
  };
}
