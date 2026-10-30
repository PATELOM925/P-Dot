import { describe, expect, it } from "vitest";
import { STARTER_PROMPTS } from "@/features/chat/starter-prompts";
import { MAX_MESSAGE_CHARS } from "@/lib/limits";
import type { Mode } from "@/types/api";

describe("starter prompts", () => {
  for (const mode of ["personal", "work"] satisfies Mode[]) {
    it(`gives 4 prompts in ${mode} mode: one web search, one Think harder`, () => {
      const prompts = STARTER_PROMPTS[mode];
      expect(prompts).toHaveLength(4);
      expect(prompts.filter((p) => p.webSearch)).toHaveLength(1);
      expect(prompts.filter((p) => p.effort === "deep")).toHaveLength(1);
      expect(new Set(prompts.map((p) => p.label)).size).toBe(4);
      for (const prompt of prompts) {
        expect(prompt.text.length).toBeGreaterThan(0);
        expect(prompt.text.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
      }
    });
  }
});
