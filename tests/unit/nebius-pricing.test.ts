import { describe, expect, it } from "vitest";
import {
  costMicroUsd,
  FALLBACK_PRICE,
  inputTokenBound,
  priceForModel,
} from "@/server/providers/nebius/pricing";

describe("Nebius pricing", () => {
  it.each([
    ["nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B", 60, 240],
    ["nvidia/Nemotron-3_5-Lightning", 60, 240],
    ["nvidia/nemotron-3-super-120b-a12b", 300, 900],
    ["nvidia/Nemotron-3.5-Super-VL", 300, 900],
    ["nvidia/Nemotron-3-Ultra-550b-a55b", 1000, 3000],
    ["Qwen/Qwen3-Embedding-8B", 10, 0],
  ])("knows the price of %s", (model, input, output) => {
    expect(priceForModel(model)).toEqual({
      price: { inputNanoUsdPerToken: input, outputNanoUsdPerToken: output },
      known: true,
    });
  });

  it("uses the most expensive price for an unknown model", () => {
    expect(FALLBACK_PRICE).toEqual({ inputNanoUsdPerToken: 1000, outputNanoUsdPerToken: 3000 });
    expect(priceForModel("someone/new-model")).toEqual({ price: FALLBACK_PRICE, known: false });
    // Not tricked by object keys that every object has.
    expect(priceForModel("constructor").known).toBe(false);
    expect(priceForModel("__proto__").known).toBe(false);
  });

  it("computes cost in micro-dollars from token usage", () => {
    const { price } = priceForModel("nvidia/nemotron-3-super-120b-a12b");
    // $0.30 per million input, $0.90 per million output.
    expect(costMicroUsd(price, { promptTokens: 1_000_000, completionTokens: 0 })).toBe(300_000);
    expect(costMicroUsd(price, { promptTokens: 0, completionTokens: 1_000_000 })).toBe(900_000);
    // The real call on 2026-10-19: 37 prompt tokens, 45 completion tokens (31 of them reasoning).
    // 37 * 300 + 45 * 900 = 51,600 nano = 51.6 micro, rounded up.
    expect(costMicroUsd(price, { promptTokens: 37, completionTokens: 45 })).toBe(52);
  });

  it("rounds up and never goes below zero", () => {
    const { price } = priceForModel("Qwen/Qwen3-Embedding-8B");
    expect(costMicroUsd(price, { promptTokens: 1, completionTokens: 0 })).toBe(1);
    expect(costMicroUsd(price, { promptTokens: -50, completionTokens: -50 })).toBe(0);
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
