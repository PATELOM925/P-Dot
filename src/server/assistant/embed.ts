import "server-only";
import { EMBEDDING_BATCH_SIZE } from "@/lib/limits";
import type { SpendGuard, SpendLimit } from "@/server/db/spend";
import { EMBEDDING_MODEL, createEmbeddings, type EmbeddingSettings } from "@/server/providers/nebius/embeddings";
import { costMicroUsd, priceForModel } from "@/server/providers/nebius/pricing";
import { MAX_NEBIUS_HOLD_MICRO_USD } from "./spend";

/** The Nebius budget refused an embedding request. */
export class EmbeddingBudgetError extends Error {
  constructor(public readonly limit: SpendLimit) {
    super(`embedding refused by the spend guard: ${limit}`);
    this.name = "EmbeddingBudgetError";
  }
}

export interface Embedder {
  /** One vector for each text, in order. Throws EmbeddingBudgetError or ProviderError. */
  embed(texts: string[], signal?: AbortSignal): Promise<number[][]>;
}

/** Worst case: every UTF-8 byte is one token, plus a small overhead for each text. */
function holdMicroUsd(texts: string[]): number {
  const price = priceForModel(EMBEDDING_MODEL);
  if (!price) throw new Error("The embedding model has no price.");
  const bytes = texts.reduce((sum, t) => sum + new TextEncoder().encode(t).length + 16, 0);
  return Math.max(1, Math.min(costMicroUsd(price, { promptTokens: bytes, completionTokens: 0 }), MAX_NEBIUS_HOLD_MICRO_USD));
}

/**
 * Embeds texts in batches. Every batch reserves its worst-case cost first and
 * settles the real cost after (the same rules as chat: no valid usage means
 * the full hold stays counted). See docs/PROVIDER-RELIABILITY.md.
 */
export function createBudgetedEmbedder(deps: {
  settings: EmbeddingSettings;
  spend: SpendGuard;
  fetchImpl?: typeof fetch;
}): Embedder {
  const price = priceForModel(EMBEDDING_MODEL);
  return {
    async embed(texts, signal) {
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += EMBEDDING_BATCH_SIZE) {
        const batch = texts.slice(i, i + EMBEDDING_BATCH_SIZE);
        const hold = holdMicroUsd(batch);
        const reservation = await deps.spend.reserve("nebius", hold);
        if (!reservation.allowed) throw new EmbeddingBudgetError(reservation.limit);
        let charged = hold;
        try {
          const result = await createEmbeddings(deps.settings, batch, { signal, fetchImpl: deps.fetchImpl });
          if (price && result.promptTokens !== null) {
            charged = Math.min(hold, costMicroUsd(price, { promptTokens: result.promptTokens, completionTokens: 0 }));
          }
          out.push(...result.vectors);
        } finally {
          // A failed settle leaves the full hold counted, which is the safe side.
          await deps.spend.settle(reservation.id, charged).catch(() => {});
        }
      }
      return out;
    },
  };
}
