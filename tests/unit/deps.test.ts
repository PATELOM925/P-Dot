import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AuthContext } from "@/server/auth/session";
import type { AssistantConfig } from "@/server/config";
import { createAssistantDeps } from "@/server/assistant/deps";
import { ProviderError } from "@/server/providers/errors";
import * as nebiusClient from "@/server/providers/nebius/client";
import { collect } from "../support/streams";

const auth: AuthContext = {
  userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  email: "alice@example.com",
  supabase: {
    from: vi.fn(),
    rpc: vi.fn(),
  } as unknown as SupabaseClient,
};

const configWithFallback: AssistantConfig = {
  nebius: {
    apiKey: "key",
    baseUrl: "https://api.test/v1",
    model: "primary-model",
    fallbackModel: "fallback-model",
    embeddingModel: "Qwen/Qwen3-Embedding-8B",
    maxOutputTokens: 256,
  },
  tavily: null,
  quota: {
    requestsPerWindow: 10,
    windowSeconds: 60,
  },
};

describe("createAssistantDeps", () => {
  it("uses primary model when it succeeds", async () => {
    const spy = vi.spyOn(nebiusClient, "streamChatCompletion").mockImplementation(async function* (settings) {
      expect(settings.model).toBe("primary-model");
      yield { type: "text", text: "primary answer" };
      yield { type: "finish", finishReason: "stop", usage: null };
    });

    const deps = createAssistantDeps(auth, configWithFallback);
    const chunks = await collect(deps.complete([{ role: "user", content: "hi" }]));

    expect(chunks).toEqual([
      { type: "text", text: "primary answer" },
      { type: "finish", finishReason: "stop", usage: null },
    ]);
    spy.mockRestore();
  });

  it("transparently falls back to secondary model if primary throws before yielding", async () => {
    let callCount = 0;
    const spy = vi.spyOn(nebiusClient, "streamChatCompletion").mockImplementation(async function* (settings) {
      callCount += 1;
      if (settings.model === "primary-model") {
        throw new ProviderError("nebius", "unavailable", 503);
      }
      expect(settings.model).toBe("fallback-model");
      yield { type: "text", text: "fallback answer" };
      yield { type: "finish", finishReason: "stop", usage: null };
    });

    const deps = createAssistantDeps(auth, configWithFallback);
    const chunks = await collect(deps.complete([{ role: "user", content: "hi" }]));

    expect(callCount).toBe(2);
    expect(chunks).toEqual([
      { type: "text", text: "fallback answer" },
      { type: "finish", finishReason: "stop", usage: null },
    ]);
    spy.mockRestore();
  });

  it("does not fallback if primary already yielded content before failing", async () => {
    let callCount = 0;
    const spy = vi.spyOn(nebiusClient, "streamChatCompletion").mockImplementation(async function* () {
      callCount += 1;
      yield { type: "text", text: "partial" };
      throw new ProviderError("nebius", "timeout");
    });

    const deps = createAssistantDeps(auth, configWithFallback);
    await expect(collect(deps.complete([{ role: "user", content: "hi" }]))).rejects.toThrow();

    expect(callCount).toBe(1);
    spy.mockRestore();
  });
});
