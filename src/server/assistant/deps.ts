import "server-only";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { AuthContext } from "@/server/auth/session";
import type { AssistantConfig } from "@/server/config";
import { createConversationRepository } from "@/server/db/conversations";
import { createQuotaGate } from "@/server/db/quota";
import { createSpendGuard } from "@/server/db/spend";
import { logEvent } from "@/server/log";
import { streamChatCompletion } from "@/server/providers/nebius/client";
import { searchWeb } from "@/server/providers/tavily/client";
import type { AssistantDeps } from "./service";

/** Wires the assistant service to real providers for one authenticated request. */
export function createAssistantDeps(auth: AuthContext, config: AssistantConfig): AssistantDeps {
  const tavily = config.tavily;
  return {
    repo: createConversationRepository(auth.supabase),
    quota: createQuotaGate(auth.supabase, config.quota.requestsPerWindow, config.quota.windowSeconds),
    spend: createSpendGuard(auth.supabase, config.spend),
    model: { id: config.nebius.model, maxOutputTokens: config.nebius.maxOutputTokens },
    search: tavily ? (query, signal) => searchWeb(tavily, query, { signal }) : null,
    complete: (messages, signal) => streamChatCompletion(config.nebius, messages, { signal }),
    now: () => new Date(),
    log: logEvent,
    waitUntil,
  };
}

/**
 * On Cloudflare Workers, work still running when the client disconnects is
 * cancelled unless it is passed to waitUntil. Outside Workers (next dev,
 * tests) there is no context, and the work simply runs.
 */
function waitUntil(work: Promise<unknown>): void {
  try {
    getCloudflareContext().ctx.waitUntil(work);
  } catch {
    // Not running in the Workers runtime.
  }
}
