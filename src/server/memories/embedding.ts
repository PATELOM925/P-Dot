import "server-only";
import type { AuthContext } from "@/server/auth/session";
import { getAssistantConfig } from "@/server/config";
import { logEvent } from "@/server/log";
import { createEmbedderForRequest } from "@/server/assistant/deps";
import { EmbeddingBudgetError } from "@/server/assistant/embed";
import { ProviderError } from "@/server/providers/errors";

/**
 * Embeds one memory's text for search. Returns null when the embedding budget
 * refuses the request or the provider fails. The memory is then saved without
 * a vector and is not used in search until it is re-embedded. Other errors
 * (for example a missing configuration, ConfigError) still reach the route.
 *
 * The log line holds the request ID and the error name only, never the text.
 */
export async function embedMemoryText(auth: AuthContext, requestId: string, text: string): Promise<number[] | null> {
  try {
    const [vector] = await createEmbedderForRequest(auth, getAssistantConfig()).embed([text]);
    return vector ?? null;
  } catch (error) {
    if (error instanceof EmbeddingBudgetError || error instanceof ProviderError) {
      logEvent("warn", "memory_embedding_failed", { requestId, errorName: error.name });
      return null;
    }
    throw error;
  }
}
