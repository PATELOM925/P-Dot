import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { DATA_SCOPES, type DataScope } from "@/server/google/oauth";
import { MCP_SERVER_IDS, type McpServerId } from "@/lib/connectors";
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
  /**
   * Deletes the row only while it still has this ciphertext, so a connection
   * made in another tab after the read is never deleted. True when a row was deleted.
   */
  deleteGoogle(userId: string, tokenCiphertext: string): Promise<boolean>;
}

/** The MCP rows of connected_accounts (decision 0016). */
export interface McpAccountRepository {
  /** The user's MCP rows (decision 0016). Read with the user's session; the ciphertext opens only in the Worker. */
  listMcp(userId: string): Promise<McpTokenRow[]>;
  getMcp(userId: string, provider: McpServerId): Promise<McpTokenRow | null>;
  /** Inserts or replaces the caller's row for the app, with no address, and marks it connected. */
  saveMcp(provider: McpServerId, subject: string, scopes: string[], tokenCiphertext: string): Promise<void>;
  /**
   * Replaces the ciphertext only while the row has this subject, the ciphertext
   * `from` and status 'connected'. True when a row changed.
   */
  swapMcpCiphertext(userId: string, provider: McpServerId, subject: string, from: string, to: string): Promise<boolean>;
  /** Only while the row still has this ciphertext. True when a row changed. */
  markMcpNeedsReconnect(userId: string, provider: McpServerId, tokenCiphertext: string): Promise<boolean>;
  /** Only while the row still has this ciphertext. True when a row was deleted. */
  deleteMcp(userId: string, provider: McpServerId, tokenCiphertext: string): Promise<boolean>;
}

export interface McpTokenRow {
  provider: McpServerId;
  subject: string;
  scopes: string[];
  status: ConnectionStatus;
  tokenCiphertext: string;
  createdAt: string;
}

const STATUS_COLUMNS = "account_email, scopes, status";

const statusRow = z.object({
  account_email: z.string(),
  scopes: z.array(z.string()),
  status: z.enum(["connected", "needs_reconnect"]),
});
const tokenRow = statusRow.extend({ account_subject: z.string(), token_ciphertext: z.string() });

const MCP_COLUMNS = "provider, account_subject, scopes, status, token_ciphertext, created_at";
const mcpRow = z.object({
  provider: z.enum(MCP_SERVER_IDS),
  account_subject: z.string(),
  scopes: z.array(z.string()),
  status: z.enum(["connected", "needs_reconnect"]),
  token_ciphertext: z.string(),
  created_at: z.string(),
});

function toMcpRow(row: z.infer<typeof mcpRow>): McpTokenRow {
  return {
    provider: row.provider,
    subject: row.account_subject,
    scopes: row.scopes,
    status: row.status,
    tokenCiphertext: row.token_ciphertext,
    createdAt: row.created_at,
  };
}

const knownScopes = (scopes: string[]) => DATA_SCOPES.filter((scope) => scopes.includes(scope));

function toConnection(row: z.infer<typeof statusRow>): GoogleConnection {
  return { email: row.account_email, scopes: knownScopes(row.scopes), status: row.status };
}

export function createConnectedAccountRepository(supabase: SupabaseClient): ConnectedAccountRepository {
  return buildRepository(supabase);
}

export function createMcpAccountRepository(supabase: SupabaseClient): McpAccountRepository {
  return buildRepository(supabase);
}

function buildRepository(supabase: SupabaseClient): ConnectedAccountRepository & McpAccountRepository {
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

    async deleteGoogle(userId, tokenCiphertext) {
      const { data, error } = await supabase
        .from("connected_accounts")
        .delete()
        .eq("user_id", userId)
        .eq("provider", "google")
        .eq("token_ciphertext", tokenCiphertext)
        .select("provider");
      if (error) throw new RepositoryError("deleteGoogle");
      return Array.isArray(data) && data.length > 0;
    },

    async listMcp(userId) {
      const { data, error } = await supabase
        .from("connected_accounts")
        .select(MCP_COLUMNS)
        .eq("user_id", userId);
      if (error) throw new RepositoryError("listMcp");
      const rows = (Array.isArray(data) ? data : []).filter((row: { provider?: unknown }) => row.provider !== "google");
      const parsed = z.array(mcpRow).safeParse(rows);
      if (!parsed.success) throw new RepositoryError("listMcp");
      return parsed.data.map(toMcpRow);
    },

    async getMcp(userId, provider) {
      const { data, error } = await supabase
        .from("connected_accounts")
        .select(MCP_COLUMNS)
        .eq("user_id", userId)
        .eq("provider", provider)
        .maybeSingle();
      if (error) throw new RepositoryError("getMcp");
      if (!data) return null;
      const parsed = mcpRow.safeParse(data);
      if (!parsed.success) throw new RepositoryError("getMcp");
      return toMcpRow(parsed.data);
    },

    async saveMcp(provider, subject, scopes, tokenCiphertext) {
      const { error } = await supabase.rpc("save_connected_account", {
        p_provider: provider,
        p_account_subject: subject,
        p_account_email: null,
        p_scopes: scopes,
        p_token_ciphertext: tokenCiphertext,
      });
      if (error) throw new RepositoryError("saveMcp");
    },

    async swapMcpCiphertext(userId, provider, subject, from, to) {
      const { data, error } = await supabase
        .from("connected_accounts")
        .update({ token_ciphertext: to })
        .eq("user_id", userId)
        .eq("provider", provider)
        .eq("account_subject", subject)
        .eq("token_ciphertext", from)
        .eq("status", "connected")
        .select("provider");
      if (error) throw new RepositoryError("swapMcpCiphertext");
      return Array.isArray(data) && data.length > 0;
    },

    async markMcpNeedsReconnect(userId, provider, tokenCiphertext) {
      const { data, error } = await supabase
        .from("connected_accounts")
        .update({ status: "needs_reconnect" })
        .eq("user_id", userId)
        .eq("provider", provider)
        .eq("token_ciphertext", tokenCiphertext)
        .select("provider");
      if (error) throw new RepositoryError("markMcpNeedsReconnect");
      return Array.isArray(data) && data.length > 0;
    },

    async deleteMcp(userId, provider, tokenCiphertext) {
      const { data, error } = await supabase
        .from("connected_accounts")
        .delete()
        .eq("user_id", userId)
        .eq("provider", provider)
        .eq("token_ciphertext", tokenCiphertext)
        .select("provider");
      if (error) throw new RepositoryError("deleteMcp");
      return Array.isArray(data) && data.length > 0;
    },
  };
}
