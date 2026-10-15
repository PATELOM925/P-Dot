import { describe, expect, it, vi } from "vitest";
import { ProviderError } from "@/server/providers/errors";
import { streamChatCompletion, type NebiusSettings } from "@/server/providers/nebius/client";
import { readSseData } from "@/server/providers/nebius/sse";
import { collect, deltaChunk, finishChunk, hangingStream, sseEvent, streamFrom } from "../support/streams";

const settings: NebiusSettings = {
  apiKey: "test-key",
  baseUrl: "https://nebius.test/v1",
  model: "test/model",
  maxOutputTokens: 256,
};

const messages = [{ role: "user" as const, content: "hi" }];

function fetchReturning(response: Response) {
  return vi.fn<typeof fetch>(async () => response);
}

function sseResponse(chunks: string[]) {
  return new Response(streamFrom(chunks), { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

async function expectProviderError(promise: Promise<unknown>, kind: string, status?: number) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ProviderError);
  expect((error as ProviderError).kind).toBe(kind);
  if (status !== undefined) expect((error as ProviderError).status).toBe(status);
}

describe("readSseData", () => {
  it("reassembles events split across chunks and ignores comments", async () => {
    const data = await collect(
      readSseData(streamFrom([": keep-alive\n\nda", 'ta: {"a":1}\r\n\r\ndata: x\ndata: y\n\n', "data: [DONE]"])),
    );
    expect(data).toEqual(['{"a":1}', "x\ny", "[DONE]"]);
  });
});

describe("streamChatCompletion", () => {
  it("sends an OpenAI-compatible streaming request with server-side credentials", async () => {
    const fetchImpl = fetchReturning(sseResponse([sseEvent(deltaChunk("Hi")), sseEvent(finishChunk()), sseEvent("[DONE]")]));
    await collect(streamChatCompletion(settings, messages, { fetchImpl }));

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://nebius.test/v1/chat/completions");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-key");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: "test/model",
      messages,
      max_tokens: 256,
      stream: true,
    });
  });

  it("yields text deltas then a finish chunk with usage", async () => {
    const fetchImpl = fetchReturning(
      sseResponse([
        sseEvent(deltaChunk("Hel")),
        sseEvent({ choices: [{ delta: { reasoning_content: "hidden thoughts" } }] }),
        sseEvent(deltaChunk("lo")),
        sseEvent(finishChunk("stop")),
        sseEvent("[DONE]"),
      ]),
    );
    const chunks = await collect(streamChatCompletion(settings, messages, { fetchImpl }));
    expect(chunks).toEqual([
      { type: "text", text: "Hel" },
      { type: "text", text: "lo" },
      { type: "finish", finishReason: "stop", usage: { promptTokens: 12, completionTokens: 3 } },
    ]);
  });

  it.each([
    [401, "auth"],
    [402, "quota"],
    [404, "invalid_request"],
    [429, "rate_limited"],
    [500, "unavailable"],
    [503, "unavailable"],
  ])("maps HTTP %i to %s", async (status, kind) => {
    const fetchImpl = fetchReturning(new Response('{"detail":"secret internal detail"}', { status }));
    await expectProviderError(collect(streamChatCompletion(settings, messages, { fetchImpl })), kind, status);
  });

  it("does not leak provider response bodies in error messages", async () => {
    const fetchImpl = fetchReturning(new Response('{"detail":"secret internal detail"}', { status: 400 }));
    const error = await collect(streamChatCompletion(settings, messages, { fetchImpl })).catch((e: Error) => e);
    expect(String((error as Error).message)).not.toContain("secret");
  });

  it("surfaces an error sent inside the stream", async () => {
    const fetchImpl = fetchReturning(
      sseResponse([
        sseEvent(deltaChunk("partial")),
        sseEvent({ error: { type: "InternalServerError", code: "internal_error", message: "x" } }),
        sseEvent("[DONE]"),
      ]),
    );
    await expectProviderError(collect(streamChatCompletion(settings, messages, { fetchImpl })), "unavailable");
  });

  it("treats a stream that ends without completing as a failure", async () => {
    const fetchImpl = fetchReturning(sseResponse([sseEvent(deltaChunk("cut off"))]));
    await expectProviderError(collect(streamChatCompletion(settings, messages, { fetchImpl })), "unavailable");
  });

  it("rejects malformed chunks", async () => {
    const fetchImpl = fetchReturning(sseResponse(["data: {not json\n\n"]));
    await expectProviderError(collect(streamChatCompletion(settings, messages, { fetchImpl })), "bad_response");
  });

  it("times out when the stream goes idle", async () => {
    // The body never closes or errors, even after abort.
    const fetchImpl = fetchReturning(new Response(hangingStream([sseEvent(deltaChunk("Hi"))]), { status: 200 }));
    await expectProviderError(
      collect(streamChatCompletion(settings, messages, { fetchImpl, idleTimeoutMs: 20, totalTimeoutMs: 5_000 })),
      "timeout",
    );
  });

  it("times out when the request never connects", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    await expectProviderError(
      collect(streamChatCompletion(settings, messages, { fetchImpl, idleTimeoutMs: 5_000, totalTimeoutMs: 20 })),
      "timeout",
    );
  });

  it("reports caller cancellation as aborted, not as a timeout", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    const pending = collect(streamChatCompletion(settings, messages, { fetchImpl, signal: controller.signal }));
    controller.abort();
    await expectProviderError(pending, "aborted");
  });
});
