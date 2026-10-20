import { describe, expect, it, vi } from "vitest";
import { ProviderError } from "@/server/providers/errors";
import {
  createEmbeddings,
  createSingleEmbedding,
  DEFAULT_EMBEDDING_MODEL,
  EMBEDDING_DIMENSION,
  type NebiusEmbeddingSettings,
} from "@/server/providers/nebius/embeddings";

const settings: NebiusEmbeddingSettings = {
  apiKey: "test-api-key",
  baseUrl: "https://api.tokenfactory.nebius.com/v1",
  model: DEFAULT_EMBEDDING_MODEL,
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("createEmbeddings", () => {
  it("computes embeddings for single text input and parses response correctly", async () => {
    const mockEmbedding = new Array(EMBEDDING_DIMENSION).fill(0.05);
    const mockFetch = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        data: [{ index: 0, embedding: mockEmbedding }],
        usage: { prompt_tokens: 4, total_tokens: 4 },
      }),
    );

    const result = await createEmbeddings(settings, "Personal document content", {
      fetchImpl: mockFetch,
    });

    expect(result.embeddings).toHaveLength(1);
    expect(result.embeddings[0]).toEqual(mockEmbedding);
    expect(result.usage?.promptTokens).toBe(4);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toBe("https://api.tokenfactory.nebius.com/v1/embeddings");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-api-key");
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe("Qwen/Qwen3-Embedding-8B");
    expect(body.input).toBe("Personal document content");
  });

  it("handles batch inputs preserving original input ordering", async () => {
    const vec1 = [0.1, 0.2];
    const vec2 = [0.3, 0.4];
    // Return out of order to verify sorting by index
    const mockFetch = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        data: [
          { index: 1, embedding: vec2 },
          { index: 0, embedding: vec1 },
        ],
        usage: { prompt_tokens: 8, total_tokens: 8 },
      }),
    );

    const result = await createEmbeddings(settings, ["first", "second"], {
      fetchImpl: mockFetch,
    });

    expect(result.embeddings).toEqual([vec1, vec2]);
  });

  it("returns empty result if input is empty array", async () => {
    const mockFetch = vi.fn<typeof fetch>();
    const result = await createEmbeddings(settings, [], { fetchImpl: mockFetch });
    expect(result.embeddings).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("throws invalid_request if input contains empty or whitespace-only text", async () => {
    await expect(createEmbeddings(settings, "   ")).rejects.toThrow(ProviderError);
    await expect(createEmbeddings(settings, ["valid", "   "])).rejects.toThrow(ProviderError);
  });

  it("maps HTTP error statuses to ProviderError", async () => {
    const mockFetch429 = vi.fn<typeof fetch>(async () =>
      new Response("Too Many Requests", { status: 429 }),
    );
    await expect(
      createEmbeddings(settings, "test", { fetchImpl: mockFetch429 }),
    ).rejects.toMatchObject({ kind: "rate_limited", status: 429 });

    const mockFetch401 = vi.fn<typeof fetch>(async () =>
      new Response("Unauthorized", { status: 401 }),
    );
    await expect(
      createEmbeddings(settings, "test", { fetchImpl: mockFetch401 }),
    ).rejects.toMatchObject({ kind: "auth", status: 401 });
  });

  it("convenience helper createSingleEmbedding returns the vector directly", async () => {
    const vec = [0.42, 0.99];
    const mockFetch = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        data: [{ index: 0, embedding: vec }],
      }),
    );
    const result = await createSingleEmbedding(settings, "single query", {
      fetchImpl: mockFetch,
    });
    expect(result).toEqual(vec);
  });
});
