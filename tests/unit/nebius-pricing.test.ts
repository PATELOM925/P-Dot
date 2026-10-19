import { describe, expect, it } from "vitest";
import { costMicroUsd, inputTokenBound, isValidUsage, priceForModel } from "@/server/providers/nebius/pricing";

describe("Nebius pricing", () => {
  it.each([
    ["nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B", 60, 240],
    ["nvidia/Nemotron-3_5-Lightning", 60, 240],
    ["nvidia/nemotron-3-super-120b-a12b", 300, 900],
    ["nvidia/Nemotron-3.5-Super-VL", 300, 900],
    ["nvidia/Nemotron-3-Ultra-550b-a55b", 1000, 3000],
    ["Qwen/Qwen3-Embedding-8B", 10, 0],
  ])("knows the price of %s", (model, input, output) => {
    expect(priceForModel(model)).toEqual({ inputNanoUsdPerToken: input, outputNanoUsdPerToken: output });
  });

  it("has no price for an unknown model (no fallback)", () => {
    // Kimi-K3 costs $3 / $15 per million tokens, more than any model in the table.
    expect(priceForModel("moonshotai/Kimi-K3")).toBeNull();
    expect(priceForModel("someone/new-model")).toBeNull();
    expect(priceForModel("NVIDIA/NEMOTRON-3-SUPER-120B-A12B")).toBeNull();
    // Not tricked by object keys that every object has.
    expect(priceForModel("constructor")).toBeNull();
    expect(priceForModel("__proto__")).toBeNull();
  });

  it("computes cost in micro-dollars from token usage", () => {
    const price = priceForModel("nvidia/nemotron-3-super-120b-a12b")!;
    // $0.30 per million input, $0.90 per million output.
    expect(costMicroUsd(price, { promptTokens: 1_000_000, completionTokens: 0 })).toBe(300_000);
    expect(costMicroUsd(price, { promptTokens: 0, completionTokens: 1_000_000 })).toBe(900_000);
    // The real call on 2026-10-19: 37 prompt tokens, 45 completion tokens (31 of them reasoning).
    // 37 * 300 + 45 * 900 = 51,600 nano = 51.6 micro, rounded up.
    expect(costMicroUsd(price, { promptTokens: 37, completionTokens: 45 })).toBe(52);
  });

  it("rounds up", () => {
    const price = priceForModel("Qwen/Qwen3-Embedding-8B")!;
    expect(costMicroUsd(price, { promptTokens: 1, completionTokens: 0 })).toBe(1);
  });

  it.each([
    [-50, 10],
    [10, -1],
    [1.5, 10],
    [10, Number.NaN],
    [Number.POSITIVE_INFINITY, 0],
    [Number.MAX_SAFE_INTEGER + 1, 0],
  ])("rejects invalid usage (%s, %s) instead of treating it as zero", (promptTokens, completionTokens) => {
    const usage = { promptTokens, completionTokens };
    expect(isValidUsage(usage)).toBe(false);
    expect(() => costMicroUsd(priceForModel("nvidia/nemotron-3-super-120b-a12b")!, usage)).toThrow(RangeError);
  });

  it("bounds input tokens by UTF-8 bytes plus template overhead", () => {
    const ascii = inputTokenBound([{ role: "user", content: "hello" }]);
    expect(ascii).toBe(5 + 16 + 64);
    // Four emoji: 4 characters in UTF-16 pairs, 16 bytes in UTF-8.
    const emoji = inputTokenBound([{ role: "user", content: "😀😀😀😀" }]);
    expect(emoji).toBe(16 + 16 + 64);
    expect(inputTokenBound([{ role: "system", content: "" }], 1000)).toBe(1000 + 16 + 64);
  });
});
