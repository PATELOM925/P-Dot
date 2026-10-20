import { describe, expect, it, vi } from "vitest";
import { EMBEDDING_DIMENSIONS } from "@/lib/limits";
import { EmbeddingBudgetError, createBudgetedEmbedder } from "@/server/assistant/embed";
import { MAX_NEBIUS_HOLD_MICRO_USD, NebiusHoldTooLargeError } from "@/server/assistant/spend";
import type { SpendGuard } from "@/server/db/spend";
import { ProviderError } from "@/server/providers/errors";
import { EMBEDDING_MODEL, createEmbeddings, toPgVector } from "@/server/providers/nebius/embeddings";

const settings = { apiKey: "test-key", baseUrl: "https://nebius.test/v1" };
const vec = (x: number, dims = EMBEDDING_DIMENSIONS) => Array.from({ length: dims }, (_, i) => (i === 0 ? x : 0));

function okResponse(vectors: number[][], promptTokens: unknown = 7, order?: number[]) {
  const idx = order ?? vectors.map((_, i) => i);
  return new Response(
    JSON.stringify({ data: idx.map((i) => ({ index: i, embedding: vectors[i] })), usage: { prompt_tokens: promptTokens } }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

function fakeSpend(allowed = true) {
  const settles: { id: string; amount: number }[] = [];
  const holds: number[] = [];
  const spend: SpendGuard = {
    reserve: vi.fn(async (_p, amount: number) => {
      holds.push(amount);
      return allowed ? { allowed: true as const, id: `r${holds.length}` } : { allowed: false as const, limit: "day" as const };
    }),
    settle: vi.fn(async (id: string, amount: number) => {
      settles.push({ id, amount });
    }),
  };
  return { spend, settles, holds };
}

describe("createEmbeddings", () => {
  it("asks for 1,024 dimensions and returns vectors in input order", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({ model: EMBEDDING_MODEL, input: ["a", "b"], dimensions: 1024 });
      return okResponse([vec(1), vec(2)], 4, [1, 0]);
    });
    const r = await createEmbeddings(settings, ["a", "b"], { fetchImpl: fetchImpl as typeof fetch });
    expect(r.vectors[0]?.[0]).toBe(1);
    expect(r.vectors[1]?.[0]).toBe(2);
    expect(r.promptTokens).toBe(4);
  });

  it("refuses vectors of the wrong size", async () => {
    const fetchImpl = vi.fn(async () => okResponse([vec(1, 4096)]));
    await expect(createEmbeddings(settings, ["a"], { fetchImpl: fetchImpl as typeof fetch })).rejects.toMatchObject({
      kind: "bad_response",
    });
  });

  it("refuses a response with a missing or repeated index", async () => {
    const fetchImpl = vi.fn(async () => okResponse([vec(1), vec(2)], 4, [0, 0]));
    await expect(createEmbeddings(settings, ["a", "b"], { fetchImpl: fetchImpl as typeof fetch })).rejects.toBeInstanceOf(
      ProviderError,
    );
  });

  it("treats invalid usage as missing", async () => {
    for (const bad of [-1, 1.5, "7", null]) {
      const fetchImpl = vi.fn(async () => okResponse([vec(1)], bad));
      const r = await createEmbeddings(settings, ["a"], { fetchImpl: fetchImpl as typeof fetch });
      expect(r.promptTokens).toBeNull();
    }
  });

  it("maps HTTP 429 to rate_limited with Retry-After", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 429, headers: { "Retry-After": "2" } }));
    await expect(createEmbeddings(settings, ["a"], { fetchImpl: fetchImpl as typeof fetch })).rejects.toMatchObject({
      kind: "rate_limited",
      status: 429,
      retryAfterMs: 2000,
    });
  });

  it("does not put the input text in the error message", async () => {
    const fetchImpl = vi.fn(async () => new Response("secret body", { status: 500 }));
    const err = await createEmbeddings(settings, ["my private note"], { fetchImpl: fetchImpl as typeof fetch }).catch(
      (e: Error) => e,
    );
    expect(String((err as Error).message)).not.toContain("private");
  });

  it("formats vectors for pgvector", () => {
    expect(toPgVector([0.5, -1])).toBe("[0.5,-1]");
  });
});

describe("createBudgetedEmbedder", () => {
  it("reserves before the call and settles the real cost after", async () => {
    const { spend, settles, holds } = fakeSpend();
    const fetchImpl = vi.fn(async () => okResponse([vec(1)], 10));
    const embedder = createBudgetedEmbedder({ settings, spend, fetchImpl: fetchImpl as typeof fetch });
    const out = await embedder.embed(["hello"]);
    expect(out).toHaveLength(1);
    expect(holds[0]).toBeGreaterThanOrEqual(1);
    // 10 tokens at 10 nano-dollars each = 0.1 micro-dollars, rounded up to at least the minimum the math gives.
    expect(settles).toHaveLength(1);
    expect(settles[0]!.amount).toBeLessThanOrEqual(holds[0]!);
  });

  it("makes no provider call when the budget refuses", async () => {
    const { spend } = fakeSpend(false);
    const fetchImpl = vi.fn(async () => okResponse([vec(1)]));
    const embedder = createBudgetedEmbedder({ settings, spend, fetchImpl: fetchImpl as typeof fetch });
    await expect(embedder.embed(["hello"])).rejects.toBeInstanceOf(EmbeddingBudgetError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps the full hold when the provider fails or sends no usage", async () => {
    const failing = fakeSpend();
    const fail = vi.fn(async () => new Response("{}", { status: 503 }));
    await expect(
      createBudgetedEmbedder({ settings, spend: failing.spend, fetchImpl: fail as typeof fetch }).embed(["x"]),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(failing.settles[0]!.amount).toBe(failing.holds[0]);

    const noUsage = fakeSpend();
    const ok = vi.fn(async () => okResponse([vec(1)], null));
    await createBudgetedEmbedder({ settings, spend: noUsage.spend, fetchImpl: ok as typeof fetch }).embed(["x"]);
    expect(noUsage.settles[0]!.amount).toBe(noUsage.holds[0]);
  });

  it("refuses a batch whose worst-case hold is above the ceiling, before any reservation or call", async () => {
    const { spend, holds, settles } = fakeSpend();
    const fetchImpl = vi.fn(async () => okResponse([vec(1)]));
    const embedder = createBudgetedEmbedder({ settings, spend, fetchImpl: fetchImpl as typeof fetch });
    // 32 texts of 800,000 bytes: a worst case of 256,006 micro-dollars, above the 250,000 ceiling.
    const big = Array.from({ length: 32 }, () => "a".repeat(800_000));
    await expect(embedder.embed(big)).rejects.toBeInstanceOf(NebiusHoldTooLargeError);
    // A small first batch is not reserved either when a later batch is too large.
    await expect(embedder.embed([...Array.from({ length: 32 }, () => "small"), ...big])).rejects.toBeInstanceOf(
      NebiusHoldTooLargeError,
    );
    expect(holds).toHaveLength(0);
    expect(settles).toHaveLength(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reserves the full worst case just under the ceiling, without reducing it", async () => {
    const { spend, holds } = fakeSpend();
    const fetchImpl = vi.fn(async () => okResponse([vec(1)], 1));
    const embedder = createBudgetedEmbedder({ settings, spend, fetchImpl: fetchImpl as typeof fetch });
    await embedder.embed(["a".repeat(24_999_000)]);
    expect(holds).toHaveLength(1);
    expect(holds[0]).toBeGreaterThan(249_000);
    expect(holds[0]).toBeLessThanOrEqual(MAX_NEBIUS_HOLD_MICRO_USD);
  });

  it("splits large inputs into batches, each with its own reservation", async () => {
    const { spend, holds, settles } = fakeSpend();
    const fetchImpl = vi.fn(async (_u: string | URL | Request, init?: RequestInit) => {
      const n = JSON.parse(String(init?.body)).input.length as number;
      return okResponse(Array.from({ length: n }, () => vec(1)), n);
    });
    const out = await createBudgetedEmbedder({ settings, spend, fetchImpl: fetchImpl as typeof fetch }).embed(
      Array.from({ length: 70 }, (_, i) => `t${i}`),
    );
    expect(out).toHaveLength(70);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(holds).toHaveLength(3);
    expect(settles).toHaveLength(3);
  });
});
