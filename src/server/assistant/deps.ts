import "server-only";
import type { AuthContext } from "@/server/auth/session";
import type { AssistantConfig } from "@/server/config";
import { createConversationRepository } from "@/server/db/conversations";
import { createQuotaGate } from "@/server/db/quota";
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
    search: tavily ? (query, signal) => searchWeb(tavily, query, { signal }) : null,
    complete: async function* (messages, signal, options) {
      const primarySettings = config.nebius;
      const fallbackModel = config.nebius.fallbackModel;
      let hasYielded = false;

      try {
        for await (const chunk of streamChatCompletion(primarySettings, messages, { signal, ...options })) {
          hasYielded = true;
          yield chunk;
        }
      } catch (error) {
        if (
          !hasYielded &&
          fallbackModel &&
          fallbackModel !== primarySettings.model &&
          !signal?.aborted
        ) {
          logEvent("warn", "model_fallback_triggered", {
            primaryModel: primarySettings.model,
            fallbackModel,
            reason: error instanceof Error ? error.message : String(error),
          });
          const fallbackSettings = { ...primarySettings, model: fallbackModel };
          yield* streamChatCompletion(fallbackSettings, messages, { signal, ...options });
          return;
        }
        throw error;
      }
    },
    now: () => new Date(),
    log: logEvent,
  };
}
