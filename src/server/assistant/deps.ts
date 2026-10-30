import "server-only";
import { hasAccount } from "@/lib/auth-identity";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { AuthContext } from "@/server/auth/session";
import { getMcpConfig, type AssistantConfig } from "@/server/config";
import { createMcpAccountRepository } from "@/server/db/connected-accounts";
import { createConnectorServices, type ConnectorServices } from "@/server/mcp/connector-turn";
import { mcpFetch } from "@/server/mcp/flow";
import { createActionProposalRepository } from "@/server/db/action-proposals";
import { createContextRecordRepository } from "@/server/db/context-records";
import { createMemoryRepository } from "@/server/db/memories";
import { createRetrievalRepository } from "@/server/db/retrieval";
import { createConversationRepository } from "@/server/db/conversations";
import { createConnectedAccountRepository } from "@/server/db/connected-accounts";
import { getGoogleConfig } from "@/server/config";
import { googleFetch } from "@/server/google/connect-flow";
import { createQuotaGate } from "@/server/db/quota";
import { createSpendGuard } from "@/server/db/spend";
import { logEvent } from "@/server/log";
import { createNebiusProvider } from "@/server/providers/model";
import { searchWeb } from "@/server/providers/tavily/client";
import { limitsFor } from "@/server/trial-limits";
import { BREAKER_DEFAULTS, createCircuitBreaker } from "./breaker";
import { createBudgetedEmbedder, type Embedder } from "./embed";
import type { ImageTextDeps } from "./image-text";
import type { AssistantDeps } from "./service";

/**
 * One breaker for each Workers isolate. Best effort: isolates do not share it,
 * and it is lost when the isolate is recycled. It only skips a failing model
 * for a short time; it never sets a limit.
 */
const breaker = createCircuitBreaker(BREAKER_DEFAULTS);

/** Wires the assistant service to real providers for one authenticated request. */
export function createAssistantDeps(auth: AuthContext, config: AssistantConfig): AssistantDeps {
  const tavily = config.tavily;
  // One guard with this user's caps (trial caps for a trial) for every paid call of the turn:
  // the reply, tool hops (also the Google ones), the title and the retrieval embeddings.
  const limits = limitsFor(auth, config);
  const spend = createSpendGuard(auth.supabase, limits.spend);
  // Google tools need a real account and the Google settings (decision 0014). The flag comes from the verified JWT.
  const googleConfig = getGoogleConfig();
  const google =
    googleConfig.status === "ready" && hasAccount(auth)
      ? {
          config: googleConfig.config,
          accounts: createConnectedAccountRepository(auth.supabase),
          proposals: createActionProposalRepository(auth.supabase),
          fetch: googleFetch,
        }
      : null;
  return {
    repo: createConversationRepository(auth.supabase),
    quota: createQuotaGate(auth.supabase, limits.quota.requestsPerWindow, limits.quota.windowSeconds),
    spend,
    routing: config.routing,
    search: tavily ? (query, signal) => searchWeb(tavily, query, { signal }) : null,
    provider: createNebiusProvider(config.nebius),
    breaker,
    now: () => new Date(),
    log: logEvent,
    waitUntil,
    contextRecords: createContextRecordRepository(auth.supabase),
    titles: true,
    google,
    googleBlocked: google ? null : hasAccount(auth) ? "not_set_up" : "demo_session",
    anonymous: !hasAccount(auth),
    connectors: connectorServicesFor(auth),
    ownData: {
      embedder: createBudgetedEmbedder({
        settings: { apiKey: config.nebius.apiKey, baseUrl: config.nebius.baseUrl },
        spend,
      }),
      retrieval: createRetrievalRepository(auth.supabase),
      memories: createMemoryRepository(auth.supabase),
      proposals: createActionProposalRepository(auth.supabase),
    },
  };
}

/** The connector services when the connector key is set (decision 0016), else null. */
export function connectorServicesFor(auth: AuthContext): ConnectorServices | null {
  const config = getMcpConfig();
  if (config.status !== "ready") return null;
  return createConnectorServices({
    repo: createMcpAccountRepository(auth.supabase),
    key: config.encryptionKey,
    userId: auth.userId,
    anonymous: !hasAccount(auth),
    fetch: mcpFetch,
    log: logEvent,
  });
}

/**
 * On Cloudflare Workers, work still running when the client disconnects is
 * cancelled unless it is passed to waitUntil. Outside Workers (next dev,
 * tests) there is no context, and the work simply runs.
 */
export function waitUntil(work: Promise<unknown>): void {
  try {
    getCloudflareContext().ctx.waitUntil(work);
  } catch {
    // Not running in the Workers runtime.
  }
}

/**
 * A spend-guarded embedder for one authenticated request. Throws ConfigError
 * (the route answers 503 not_configured) when Nebius is not configured.
 */
export function createEmbedderForRequest(auth: AuthContext, config: AssistantConfig): Embedder {
  return createBudgetedEmbedder({
    settings: { apiKey: config.nebius.apiKey, baseUrl: config.nebius.baseUrl },
    spend: createSpendGuard(auth.supabase, limitsFor(auth, config).spend),
  });
}

/**
 * The image text call for one authenticated request (decision 0019): the
 * vision tier with this user's quota and spend caps (trial caps for a trial),
 * as chat has. Throws ConfigError when Nebius is not configured.
 */
export function createImageTextDeps(auth: AuthContext, config: AssistantConfig): ImageTextDeps {
  const limits = limitsFor(auth, config);
  return {
    provider: createNebiusProvider(config.nebius),
    spend: createSpendGuard(auth.supabase, limits.spend),
    quota: createQuotaGate(auth.supabase, limits.quota.requestsPerWindow, limits.quota.windowSeconds),
    breaker,
    vision: config.routing.vision,
    now: () => new Date(),
  };
}
