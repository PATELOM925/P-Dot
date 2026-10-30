import "server-only";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { AuthContext } from "@/server/auth/session";
import type { AssistantConfig } from "@/server/config";
import { createContextRecordRepository } from "@/server/db/context-records";
import { createConversationRepository } from "@/server/db/conversations";
import { createQuotaGate } from "@/server/db/quota";
import { createSpendGuard } from "@/server/db/spend";
import { logEvent } from "@/server/log";
import { createNebiusProvider } from "@/server/providers/model";
import { searchWeb } from "@/server/providers/tavily/client";
import { limitsFor } from "@/server/trial-limits";
import { BREAKER_DEFAULTS, createCircuitBreaker } from "./breaker";
import { createBudgetedEmbedder, type Embedder } from "./embed";
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
  const limits = limitsFor(auth, config);
  return {
    repo: createConversationRepository(auth.supabase),
    quota: createQuotaGate(auth.supabase, limits.quota.requestsPerWindow, limits.quota.windowSeconds),
    spend: createSpendGuard(auth.supabase, limits.spend),
    routing: config.routing,
    search: tavily ? (query, signal) => searchWeb(tavily, query, { signal }) : null,
    provider: createNebiusProvider(config.nebius),
    breaker,
    now: () => new Date(),
    log: logEvent,
    waitUntil,
    contextRecords: createContextRecordRepository(auth.supabase),
  };
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
