import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { RepositoryError } from "./conversations";

/**
 * The user's Telegram link (decision 0020). Every call runs with the user's
 * session, so RLS keeps it to the user's own row. The chat is sealed by the
 * Worker; this module never opens it.
 */
export interface TelegramLinkView {
  /** The sealed chat, or null when no chat is linked. */
  chatCiphertext: string | null;
  linkedAt: string | null;
}

export interface TelegramLinkRepository {
  getLink(userId: string): Promise<TelegramLinkView | null>;
  /** Stores the hash of a new code for 10 minutes (database clock). Returns when it ends. */
  startLink(codeHash: string): Promise<string>;
  /** Links the sealed chat when the code hash is the user's pending one and has not ended. Once. */
  confirmLink(codeHash: string, chatCiphertext: string): Promise<boolean>;
  /** The sealed chat when this key is new for the user's linked chat, else null. */
  claimSend(key: string): Promise<string | null>;
  /** Deletes the user's row. True when a row was deleted. */
  unlink(userId: string): Promise<boolean>;
}

const linkRow = z.object({ chat_ciphertext: z.string().nullable(), linked_at: z.string().nullable() });

export function createTelegramLinkRepository(supabase: SupabaseClient): TelegramLinkRepository {
  return {
    async getLink(userId) {
      const { data, error } = await supabase.from("telegram_links").select("chat_ciphertext, linked_at").eq("user_id", userId).limit(1);
      if (error) throw new RepositoryError("getTelegramLink");
      const row = Array.isArray(data) ? data[0] : undefined;
      if (!row) return null;
      const parsed = linkRow.safeParse(row);
      if (!parsed.success) throw new RepositoryError("getTelegramLink");
      return { chatCiphertext: parsed.data.chat_ciphertext, linkedAt: parsed.data.linked_at };
    },

    async startLink(codeHash) {
      const { data, error } = await supabase.rpc("start_telegram_link", { p_code_hash: codeHash });
      const parsed = z.string().min(1).safeParse(data);
      if (error || !parsed.success) throw new RepositoryError("startTelegramLink");
      return parsed.data;
    },

    async confirmLink(codeHash, chatCiphertext) {
      const { data, error } = await supabase.rpc("confirm_telegram_link", { p_code_hash: codeHash, p_chat_ciphertext: chatCiphertext });
      if (error || typeof data !== "boolean") throw new RepositoryError("confirmTelegramLink");
      return data;
    },

    async claimSend(key) {
      const { data, error } = await supabase.rpc("claim_telegram_send", { p_key: key });
      if (error) throw new RepositoryError("claimTelegramSend");
      const parsed = z.string().min(1).nullable().safeParse(data ?? null);
      if (!parsed.success) throw new RepositoryError("claimTelegramSend");
      return parsed.data;
    },

    async unlink(userId) {
      const { data, error } = await supabase.from("telegram_links").delete().eq("user_id", userId).select("user_id");
      if (error) throw new RepositoryError("unlinkTelegram");
      return Array.isArray(data) && data.length > 0;
    },
  };
}
