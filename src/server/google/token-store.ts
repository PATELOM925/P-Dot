import "server-only";
import type { GoogleConfig } from "@/server/config";
import type { ConnectedAccountRepository } from "@/server/db/connected-accounts";
import { logEvent } from "@/server/log";
import { openText, tokenAssociatedData } from "./crypto";
import type { FetchLike } from "./http";
import { isDeadRefreshToken, refreshAccessToken, type DataScope } from "./oauth";

/** Google refused the stored refresh token. The row is now `needs_reconnect`. */
export class GoogleReconnectNeededError extends Error {
  override readonly name = "GoogleReconnectNeededError";
  constructor() {
    super("Google access ended. Connect again.");
  }
}

/**
 * Access to one user's Google account for one request. The access token stays
 * in this object's memory only, and is never stored or logged.
 */
export interface GoogleAccess {
  /** Google's `sub` for the connected account. */
  readonly subject: string;
  readonly scopes: readonly DataScope[];
  readonly fetch: FetchLike;
  /** A valid access token. Refreshes when there is none or it ends within 60 seconds. */
  accessToken(): Promise<string>;
}

export type GoogleAccessResult =
  | { ok: true; access: GoogleAccess }
  | { ok: false; reason: "not_connected" | "needs_reconnect" };

const EARLY_REFRESH_MS = 60_000;

export interface GoogleAccessDeps {
  repo: ConnectedAccountRepository;
  config: GoogleConfig;
  fetch: FetchLike;
  userId: string;
  requestId: string;
  now?: () => number;
}

export async function openGoogleAccess(deps: GoogleAccessDeps): Promise<GoogleAccessResult> {
  const { repo, config, userId, requestId } = deps;
  const now = deps.now ?? Date.now;
  const row = await repo.getGoogleToken(userId);
  if (!row) return { ok: false, reason: "not_connected" };
  if (row.status === "needs_reconnect") return { ok: false, reason: "needs_reconnect" };

  const markDead = async () => {
    try {
      await repo.markGoogleNeedsReconnect(userId, row.tokenCiphertext);
    } catch {
      logEvent("warn", "google_mark_reconnect_failed", { requestId });
    }
  };

  const refreshToken = await openText(config.encryptionKey, row.tokenCiphertext, tokenAssociatedData(userId, "google"));
  if (refreshToken === null) {
    // A changed key or a changed row. Only a new Connect can fix it.
    logEvent("warn", "google_token_unreadable", { requestId });
    await markDead();
    return { ok: false, reason: "needs_reconnect" };
  }

  let cached: { token: string; expiresAt: number } | null = null;
  let pending: Promise<string> | null = null;

  const refresh = async (): Promise<string> => {
    try {
      const fresh = await refreshAccessToken(deps.fetch, config, refreshToken);
      cached = { token: fresh.accessToken, expiresAt: now() + fresh.expiresIn * 1000 };
      return fresh.accessToken;
    } catch (error) {
      if (isDeadRefreshToken(error)) {
        logEvent("warn", "google_refresh_token_ended", { requestId });
        await markDead();
        throw new GoogleReconnectNeededError();
      }
      throw error;
    }
  };

  return {
    ok: true,
    access: {
      subject: row.subject,
      scopes: row.scopes,
      fetch: deps.fetch,
      accessToken() {
        if (cached && cached.expiresAt - EARLY_REFRESH_MS > now()) return Promise.resolve(cached.token);
        pending ??= refresh().finally(() => {
          pending = null;
        });
        return pending;
      },
    },
  };
}
