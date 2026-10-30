import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { MAX_IMAGE_TEXT_BODY_BYTES } from "@/lib/limits";
import { ConfigError } from "@/lib/supabase-config";
import type { AuthContext } from "@/server/auth/session";
import { createCircuitBreaker } from "@/server/assistant/breaker";
import { IMAGE_TEXT_MAX_OUTPUT_TOKENS, type ImageTextDeps } from "@/server/assistant/image-text";
import { nebiusHoldMicroUsd } from "@/server/assistant/spend";
import type { AssistantConfig } from "@/server/config";
import { inputTokenBound, TOKENS_PER_IMAGE } from "@/server/providers/nebius/pricing";
import { streamChatCompletion } from "@/server/providers/nebius/client";
import { FakeProvider, type FakeBehavior } from "../support/fake-provider";
import { FakeQuota, FakeSpend, testRouting } from "../support/fakes";
import { collect, deltaChunk, finishChunk, sseEvent, streamFrom } from "../support/streams";

vi.mock("@/server/auth/session", () => ({ getAuthContext: vi.fn() }));
vi.mock("@/server/config", () => ({ getAssistantConfig: vi.fn() }));
vi.mock("@/server/assistant/deps", () => ({ createImageTextDeps: vi.fn() }));

const { getAuthContext } = await import("@/server/auth/session");
const { getAssistantConfig } = await import("@/server/config");
const { createImageTextDeps } = await import("@/server/assistant/deps");
const route = await import("@/app/api/documents/image-text/route");

const ALICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const VISION = "nvidia/Nemotron-3.5-Super-VL";
/** A JPEG data URL with a marker that must never appear in a log. */
const IMAGE = `data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ${"IMAGEMARKER".repeat(4)}AAAA`;
const SECRET_TEXT = "Invoice SECRET-MARKER-42";

let provider: FakeProvider;
let spend: FakeSpend;
let quota: FakeQuota;
let logs: string[];

function setDeps(scripts: Record<string, FakeBehavior[]>, options: { allowQuota?: boolean } = {}) {
  provider = new FakeProvider(scripts);
  spend = new FakeSpend();
  quota = new FakeQuota(options.allowQuota ?? true);
  const deps: ImageTextDeps = {
    provider,
    spend,
    quota,
    breaker: createCircuitBreaker({ threshold: 3, cooldownMs: 30_000 }),
    vision: testRouting(VISION).vision,
    now: () => new Date(Date.UTC(2026, 9, 14, 12, 0, 0)),
    random: () => 0,
  };
  vi.mocked(createImageTextDeps).mockReturnValue(deps);
}

function signInAs(userId: string | null, isAnonymous = false) {
  vi.mocked(getAuthContext).mockResolvedValue(
    userId
      ? ({ userId, email: null, isAnonymous, supabase: {} as SupabaseClient } as unknown as AuthContext)
      : null,
  );
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/documents/image-text", {
    method: "POST",
    headers: { host: "localhost", origin: "http://localhost", "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const READ_OK: FakeBehavior[] = [
  { chunks: [{ text: `Text in the image:\n${SECRET_TEXT}\n\nDescription:\nA paper invoice.` }], usage: { promptTokens: 3000, completionTokens: 40 } },
];

beforeEach(() => {
  vi.mocked(getAssistantConfig).mockReturnValue({} as AssistantConfig);
  setDeps({ [VISION]: READ_OK });
  logs = [];
  for (const method of ["info", "warn", "error", "log"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/documents/image-text", () => {
  it("refuses a signed-out user before any quota, hold or model call", async () => {
    signInAs(null);
    const response = await route.POST(post({ image: IMAGE }));
    expect(response.status).toBe(401);
    expect(quota.calls).toBe(0);
    expect(spend.reservations).toHaveLength(0);
    expect(provider.calls).toHaveLength(0);
  });

  it("refuses a cross-origin request", async () => {
    signInAs(ALICE);
    const response = await route.POST(post({ image: IMAGE }, { origin: "https://evil.example" }));
    expect(response.status).toBe(403);
    expect(provider.calls).toHaveLength(0);
  });

  it.each([
    ["a PNG data URL", { image: "data:image/png;base64,iVBORw0KGgo=" }],
    ["a JPEG type with other bytes", { image: "data:image/jpeg;base64,iVBORw0KGgo=" }],
    ["a URL", { image: "https://example.com/a.jpg" }],
    ["text that is not base64", { image: "data:image/jpeg;base64,/9j/<script>" }],
    ["an extra field", { image: IMAGE, userId: "x" }],
    ["no image", {}],
  ])("refuses %s with 400 and calls nothing", async (_label, body) => {
    signInAs(ALICE);
    const response = await route.POST(post(body));
    expect(response.status).toBe(400);
    expect(quota.calls).toBe(0);
    expect(provider.calls).toHaveLength(0);
  });

  it("refuses a body over the size limit with 413", async () => {
    signInAs(ALICE);
    const big = `data:image/jpeg;base64,/9j/${"A".repeat(MAX_IMAGE_TEXT_BODY_BYTES)}`;
    const response = await route.POST(post({ image: big }));
    expect(response.status).toBe(413);
    expect(provider.calls).toHaveLength(0);
  });

  it("answers 503 not_configured when Nebius is not configured", async () => {
    signInAs(ALICE);
    vi.mocked(getAssistantConfig).mockImplementation(() => {
      throw new ConfigError(["NEBIUS_API_KEY"]);
    });
    const response = await route.POST(post({ image: IMAGE }));
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("not_configured");
    expect(provider.calls).toHaveLength(0);
  });

  it("stops at the per-user request quota before any hold or model call", async () => {
    signInAs(ALICE);
    setDeps({ [VISION]: READ_OK }, { allowQuota: false });
    const response = await route.POST(post({ image: IMAGE }));
    expect(response.status).toBe(429);
    expect((await response.json()).error.code).toBe("rate_limited");
    expect(response.headers.get("Retry-After")).toBeTruthy();
    expect(spend.reservations).toHaveLength(0);
    expect(provider.calls).toHaveLength(0);
  });

  it.each([
    ["user", 429],
    ["day", 429],
    ["period", 503],
  ] as const)("stops when the spend guard refuses the %s cap, with no model call", async (limit, status) => {
    signInAs(ALICE);
    spend.refuse.nebius = limit;
    const response = await route.POST(post({ image: IMAGE }));
    expect(response.status).toBe(status);
    expect((await response.json()).error.code).toBe("budget_exhausted");
    expect(provider.calls).toHaveLength(0);
  });

  it("reads the image once on the vision model, holds the worst case with the image and settles the real cost", async () => {
    signInAs(ALICE);
    const response = await route.POST(post({ image: IMAGE }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.text).toBe(`Text in the image:\n${SECRET_TEXT}\n\nDescription:\nA paper invoice.`);

    expect(provider.calls).toHaveLength(1);
    const request = provider.calls[0]!.request;
    expect(request.model).toBe(VISION);
    expect(request.maxOutputTokens).toBe(IMAGE_TEXT_MAX_OUTPUT_TOKENS);
    expect(request.thinkingBudgetTokens).toBe(0);
    expect(request.messages.at(-1)).toMatchObject({ role: "user", images: [IMAGE] });

    expect(spend.reservations).toHaveLength(1);
    const reservation = spend.reservations[0]!;
    expect(reservation.held).toBe(nebiusHoldMicroUsd(VISION, request.messages, IMAGE_TEXT_MAX_OUTPUT_TOKENS));
    // 3,000 in at 300 nano and 40 out at 900 nano.
    expect(reservation.settled).toBe(Math.ceil((3000 * 300 + 40 * 900) / 1000));
  });

  it("works for a trial user: the deps carry the trial caps", async () => {
    signInAs(ALICE, true);
    const response = await route.POST(post({ image: IMAGE }));
    expect(response.status).toBe(200);
    expect(vi.mocked(createImageTextDeps).mock.calls.at(-1)![0]).toMatchObject({ isAnonymous: true });
  });

  it("answers 502 when the model fails, and keeps the full hold counted when the call was sent", async () => {
    signInAs(ALICE);
    setDeps({ [VISION]: [{ status: 500 }] });
    const response = await route.POST(post({ image: IMAGE }));
    expect(response.status).toBe(502);
    expect((await response.json()).error.code).toBe("provider_unavailable");
    expect(spend.reservations.length).toBeGreaterThan(0);
    expect(spend.reservations.every((r) => r.settled !== null)).toBe(true);
  });

  it("answers 502 when the model sends only a reasoning block", async () => {
    signInAs(ALICE);
    setDeps({ [VISION]: [{ chunks: [{ text: "<think>hmm</think>  " }] }] });
    const response = await route.POST(post({ image: IMAGE }));
    expect(response.status).toBe(502);
  });

  it("never logs the image or the text", async () => {
    signInAs(ALICE);
    await route.POST(post({ image: IMAGE }));
    setDeps({ [VISION]: [{ status: 500 }] });
    await route.POST(post({ image: IMAGE }));
    const all = logs.join("\n");
    expect(all).toContain("image_text");
    expect(all).not.toContain("IMAGEMARKER");
    expect(all).not.toContain("SECRET-MARKER");
  });
});

describe("images in a Nebius request", () => {
  it("sends the image as an image_url part after the text", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(streamFrom([sseEvent(deltaChunk("Hi")), sseEvent(finishChunk()), sseEvent("[DONE]")]), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
    );
    await collect(
      streamChatCompletion(
        { apiKey: "k", baseUrl: "https://nebius.test/v1", model: VISION, maxOutputTokens: 16 },
        [
          { role: "system", content: "sys" },
          { role: "user", content: "Read this image.", images: [IMAGE] },
        ],
        { fetchImpl },
      ),
    );
    const body = JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body));
    expect(body.messages[0]).toEqual({ role: "system", content: "sys" });
    expect(body.messages[1]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "Read this image." },
        { type: "image_url", image_url: { url: IMAGE } },
      ],
    });
  });

  it("counts each image as a fixed token bound in the worst-case hold", () => {
    const without = inputTokenBound([{ role: "user", content: "Read this image." }]);
    const withImage = inputTokenBound([{ role: "user", content: "Read this image.", images: [IMAGE] }]);
    expect(withImage - without).toBe(TOKENS_PER_IMAGE);
  });
});
