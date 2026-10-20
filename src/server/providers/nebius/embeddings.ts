import "server-only";
import { z } from "zod";
import {
  createAbortScope,
  discardBody,
  kindFromStatus,
  ProviderError,
} from "../errors";

export interface NebiusEmbeddingSettings {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export interface EmbeddingOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  totalTimeoutMs?: number;
}

export interface EmbeddingResult {
  embeddings: number[][];
  usage?: {
    promptTokens: number;
    totalTokens: number;
  };
}

const embeddingResponseSchema = z.object({
  data: z.array(
    z.object({
      embedding: z.array(z.number()),
      index: z.number().optional(),
    }),
  ),
  usage: z
    .object({
      prompt_tokens: z.number().optional(),
      total_tokens: z.number().optional(),
    })
    .optional(),
});

export const DEFAULT_EMBEDDING_MODEL = "Qwen/Qwen3-Embedding-8B";
export const EMBEDDING_DIMENSION = 4096;

/**
 * Generates vector embeddings for one or more text inputs using Nebius Token Factory.
 * https://api.tokenfactory.nebius.com/v1/embeddings
 */
export async function createEmbeddings(
  settings: NebiusEmbeddingSettings,
  input: string | string[],
  options: EmbeddingOptions = {},
): Promise<EmbeddingResult> {
  const texts = Array.isArray(input) ? input : [input];
  if (texts.length === 0) {
    return { embeddings: [], usage: { promptTokens: 0, totalTokens: 0 } };
  }

  // Validate non-empty strings
  const sanitized = texts.map((t) => t.trim());
  if (sanitized.some((t) => t.length === 0)) {
    throw new ProviderError("nebius", "invalid_request");
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.totalTimeoutMs ?? 15_000;
  const scope = createAbortScope({ totalMs: timeoutMs, parent: options.signal });

  const url = `${settings.baseUrl.replace(/\/+$/, "")}/embeddings`;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${settings.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: settings.model || DEFAULT_EMBEDDING_MODEL,
        input: sanitized.length === 1 ? sanitized[0] : sanitized,
      }),
      signal: scope.signal,
    });
  } catch {
    scope.dispose();
    if (scope.timedOut()) throw new ProviderError("nebius", "timeout");
    if (options.signal?.aborted) throw new ProviderError("nebius", "aborted");
    throw new ProviderError("nebius", "unavailable");
  }

  if (!response.ok) {
    scope.dispose();
    await discardBody(response);
    throw new ProviderError("nebius", kindFromStatus(response.status), response.status);
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    scope.dispose();
    throw new ProviderError("nebius", "bad_response");
  } finally {
    scope.dispose();
  }

  const parsed = embeddingResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new ProviderError("nebius", "bad_response");
  }

  // Sort by index if present to guarantee identical order to input texts
  const sorted = [...parsed.data.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const embeddings = sorted.map((item) => item.embedding);

  return {
    embeddings,
    usage: parsed.data.usage
      ? {
          promptTokens: parsed.data.usage.prompt_tokens ?? 0,
          totalTokens: parsed.data.usage.total_tokens ?? 0,
        }
      : undefined,
  };
}

/**
 * Convenience helper to compute a single text embedding vector.
 */
export async function createSingleEmbedding(
  settings: NebiusEmbeddingSettings,
  text: string,
  options: EmbeddingOptions = {},
): Promise<number[]> {
  const result = await createEmbeddings(settings, text, options);
  const first = result.embeddings[0];
  if (!first) {
    throw new ProviderError("nebius", "bad_response");
  }
  return first;
}
