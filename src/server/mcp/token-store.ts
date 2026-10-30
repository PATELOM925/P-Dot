import "server-only";
import type { McpAccountRepository, McpTokenRow } from "@/server/db/connected-accounts";
import type { FetchLike } from "@/server/google/http";
import type { Logger } from "@/server/log";
import type { McpServer } from "./catalog";
import { MAX_SEALED_CHARS, openBundle, sealBundle, type McpBundle } from "./bundle";
import { refreshTokens } from "./oauth";

// Access to one MCP connection for one request (decision 0016, "Refresh
// contract"). The refresh is fenced by a compare-and-swap on the ciphertext:
// a claim, the new tokens and a rollback each name the ciphertext this request
// read and status 'connected'. A disconnect, a reconnect or a mark by another
// request makes the write match no row, and this request then uses nothing.
// An unknown refresh result never sends the old refresh token again.

export const EARLY_REFRESH_MS = 60_000;
export const CLAIM_MS = 30_000;
/** The claim owner does not send the refresh with less than this left. */
export const MIN_CLAIM_LEFT_MS = 20_000;
const BUSY_WAITS = 3;
const BUSY_WAIT_MS = 300;

export type McpAccessFailure = "not_connected" | "needs_reconnect" | "busy" | "changed";

export class McpAccessError extends Error {
  override readonly name = "McpAccessError";
  constructor(readonly reason: McpAccessFailure) {
    super(`MCP access failed: ${reason}`);
  }
}

export interface McpAccess {
  /** Pins from Connect, keyed by the remote tool name. */
  readonly pins: Readonly<Record<string, string>>;
  /** A valid access token. `force` refreshes after a 401. Throws McpAccessError. */
  token(force: boolean): Promise<string>;
}

export interface McpAccessDeps {
  repo: McpAccountRepository;
  key: Uint8Array;
  server: McpServer;
  userId: string;
  fetch: FetchLike;
  requestId: string;
  log: Logger;
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface Current {
  row: McpTokenRow;
  bundle: McpBundle;
}

export async function openMcpAccess(deps: McpAccessDeps): Promise<McpAccess> {
  const { repo, key, server, userId } = deps;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const log = (event: string) => deps.log("warn", event, { requestId: deps.requestId, server: server.id });

  const mark = async (ciphertext: string) => {
    try {
      await repo.markMcpNeedsReconnect(userId, server.id, ciphertext);
    } catch {
      log("mcp_mark_reconnect_failed");
    }
  };

  /** The row and its bundle, only while connected. */
  const read = async (): Promise<Current> => {
    const row = await repo.getMcp(userId, server.id);
    if (!row) throw new McpAccessError("not_connected");
    if (row.status !== "connected") throw new McpAccessError("needs_reconnect");
    const bundle = await openBundle(key, userId, server, row.subject, row.tokenCiphertext);
    if (!bundle) {
      log("mcp_token_unreadable");
      await mark(row.tokenCiphertext);
      throw new McpAccessError("needs_reconnect");
    }
    return { row, bundle };
  };

  let current = await read();
  const subject = current.row.subject;
  const fresh = (bundle: McpBundle) => bundle.accessExpiresAt - EARLY_REFRESH_MS > now();

  const refresh = async (force: boolean): Promise<string> => {
    const startToken = current.bundle.accessToken;
    for (let wait = 0; ; wait += 1) {
      const { row, bundle } = current;
      if (row.subject !== subject) throw new McpAccessError("changed");
      if (fresh(bundle) && (!force || bundle.accessToken !== startToken)) return bundle.accessToken;
      if (bundle.claim) {
        if (bundle.claim.until > now()) {
          if (wait >= BUSY_WAITS) throw new McpAccessError("busy");
          await sleep(BUSY_WAIT_MS);
          current = await read();
          continue;
        }
        // An earlier request may have sent this refresh token. Never send it again.
        log("mcp_refresh_claim_expired");
        await mark(row.tokenCiphertext);
        throw new McpAccessError("needs_reconnect");
      }
      if (!bundle.refreshToken) {
        await mark(row.tokenCiphertext);
        throw new McpAccessError("needs_reconnect");
      }

      const until = now() + CLAIM_MS;
      const claimed = await sealBundle(key, userId, subject, { ...bundle, claim: { id: crypto.randomUUID(), until } });
      if (!(await repo.swapMcpCiphertext(userId, server.id, subject, row.tokenCiphertext, claimed))) {
        current = await read();
        if (wait >= BUSY_WAITS) throw new McpAccessError("busy");
        continue;
      }
      return sendRefresh(row.tokenCiphertext, claimed, bundle, until);
    }
  };

  const sendRefresh = async (before: string, claimed: string, bundle: McpBundle, until: number): Promise<string> => {
    if (deps.signal?.aborted || until - now() < MIN_CLAIM_LEFT_MS) {
      // Nothing was sent: give the row back as it was.
      await repo.swapMcpCiphertext(userId, server.id, subject, claimed, before).catch(() => log("mcp_claim_release_failed"));
      throw deps.signal?.aborted ? deps.signal.reason : new McpAccessError("busy");
    }
    let next: McpBundle;
    try {
      const tokens = await refreshTokens(
        deps.fetch,
        server,
        { tokenEndpoint: bundle.tokenEndpoint, clientId: bundle.clientId, refreshToken: bundle.refreshToken! },
        now(),
      );
      next = { ...bundle, accessToken: tokens.accessToken, accessExpiresAt: tokens.accessExpiresAt, refreshToken: tokens.refreshToken, claim: null };
    } catch {
      log("mcp_refresh_failed");
      await mark(claimed);
      throw new McpAccessError("needs_reconnect");
    }
    const sealed = await sealBundle(key, userId, subject, next);
    if (sealed.length > MAX_SEALED_CHARS) {
      await mark(claimed);
      throw new McpAccessError("needs_reconnect");
    }

    let stored: boolean;
    try {
      stored = await repo.swapMcpCiphertext(userId, server.id, subject, claimed, sealed);
    } catch {
      stored = await readBack(claimed, sealed);
    }
    if (!stored) {
      log("mcp_refresh_store_lost");
      throw new McpAccessError("changed");
    }
    current = { row: { ...current.row, tokenCiphertext: sealed, status: "connected" }, bundle: next };
    return next.accessToken;
  };

  /** After a store whose answer was lost: true only when the row holds the new ciphertext and is connected. */
  const readBack = async (claimed: string, sealed: string): Promise<boolean> => {
    let row: McpTokenRow | null;
    try {
      row = await repo.getMcp(userId, server.id);
    } catch {
      await mark(claimed);
      return false;
    }
    if (!row || row.subject !== subject || row.status !== "connected") return false;
    if (row.tokenCiphertext === sealed) return true;
    if (row.tokenCiphertext !== claimed) return false;
    try {
      if (await repo.swapMcpCiphertext(userId, server.id, subject, claimed, sealed)) return true;
    } catch {
      // Fall through: the new refresh token is lost and the old one is spent.
    }
    await mark(claimed);
    return false;
  };

  let pending: Promise<string> | null = null;
  return {
    pins: current.bundle.pins,
    token(force) {
      if (!force && !pending && fresh(current.bundle)) return Promise.resolve(current.bundle.accessToken);
      pending ??= refresh(force).finally(() => {
        pending = null;
      });
      return pending;
    },
  };
}
