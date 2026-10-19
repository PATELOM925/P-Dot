import { describe, expect, it, vi } from "vitest";
import { ProviderError } from "@/server/providers/errors";
import { streamChatCompletion, type NebiusSettings } from "@/server/providers/nebius/client";
import { readSseData } from "@/server/providers/nebius/sse";
import { createThinkFilter } from "@/server/providers/nebius/think";
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
      stream_options: { include_usage: true },
      chat_template_kwargs: { enable_thinking: false },
    });
  });

  // Shapes copied from a real Token Factory stream (nvidia/nemotron-3-super-120b-a12b, 2026-10-19):
  // reasoning comes in both `reasoning` and `reasoning_content`, the finish reason comes in its
  // own chunk, and usage comes after it in a chunk with an empty `choices` list.
  it("parses usage from the last chunk and ignores reasoning fields, as Nebius really sends them", async () => {
    const fetchImpl = fetchReturning(
      sseResponse([
        sseEvent({ object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "" }, logprobs: null, finish_reason: null }], prompt_token_ids: null }),
        sseEvent({ object: "chat.completion.chunk", choices: [{ index: 0, delta: { reasoning: "User asks", reasoning_content: "User asks" }, logprobs: null, finish_reason: null, token_ids: null }] }),
        sseEvent(deltaChunk("\n\nSeventeen multiplied by three equals fifty-one.")),
        sseEvent({ object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "" }, logprobs: null, finish_reason: "stop", stop_reason: null }] }),
        sseEvent({
          object: "chat.completion.chunk",
          choices: [],
          usage: {
            prompt_tokens: 37,
            total_tokens: 82,
            completion_tokens: 45,
            prompt_tokens_details: { cached_tokens: 0, created_cache_tokens: 0 },
            completion_tokens_details: { reasoning_tokens: 31 },
          },
        }),
        sseEvent("[DONE]"),
      ]),
    );
    const chunks = await collect(streamChatCompletion(settings, messages, { fetchImpl }));
    expect(chunks).toEqual([
      { type: "text", text: "\n\nSeventeen multiplied by three equals fifty-one." },
      { type: "finish", finishReason: "stop", usage: { promptTokens: 37, completionTokens: 45 } },
    ]);
  });

  it.each([
    ["negative", { prompt_tokens: -1, completion_tokens: 3 }],
    ["fractional", { prompt_tokens: 1.5, completion_tokens: 3 }],
    ["not a number", { prompt_tokens: "12", completion_tokens: 3 }],
    ["unsafe integer", { prompt_tokens: Number.MAX_SAFE_INTEGER + 1, completion_tokens: 3 }],
    ["missing field", { prompt_tokens: 12 }],
    ["not an object", 42],
  ])("treats %s usage as missing usage, not as an error", async (_label, usage) => {
    const fetchImpl = fetchReturning(
      sseResponse([
        sseEvent(deltaChunk("Hi")),
        sseEvent({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
        sseEvent({ choices: [], usage }),
        sseEvent("[DONE]"),
      ]),
    );
    const chunks = await collect(streamChatCompletion(settings, messages, { fetchImpl }));
    expect(chunks).toEqual([
      { type: "text", text: "Hi" },
      { type: "finish", finishReason: "stop", usage: null },
    ]);
  });

  it("reports missing usage as null", async () => {
    const fetchImpl = fetchReturning(
      sseResponse([
        sseEvent(deltaChunk("Hi")),
        sseEvent({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
        sseEvent("[DONE]"),
      ]),
    );
    const chunks = await collect(streamChatCompletion(settings, messages, { fetchImpl }));
    expect(chunks.at(-1)).toEqual({ type: "finish", finishReason: "stop", usage: null });
  });

  it("removes a <think> block written into the reply text", async () => {
    const fetchImpl = fetchReturning(
      sseResponse([
        sseEvent(deltaChunk("<thi")),
        sseEvent(deltaChunk("nk>secret plan</th")),
        sseEvent(deltaChunk("ink>\n\nAnswer.")),
        sseEvent(finishChunk()),
        sseEvent("[DONE]"),
      ]),
    );
    const chunks = await collect(streamChatCompletion(settings, messages, { fetchImpl }));
    const text = chunks.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");
    expect(text).toBe("Answer.");
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

describe("createThinkFilter", () => {
  function run(chunks: string[]) {
    const filter = createThinkFilter();
    return chunks.map((c) => filter.push(c)).join("") + filter.flush();
  }

  it("passes normal text through unchanged, including leading whitespace", () => {
    expect(run(["\n\nHello", " world"])).toBe("\n\nHello world");
    expect(run(["<b>bold</b>"])).toBe("<b>bold</b>");
    expect(run(["I think <think> is a tag"])).toBe("I think <think> is a tag");
  });

  it("drops a leading reasoning block split across chunks", () => {
    expect(run(["  <", "think>", "a", "b</", "think>", " ", "Reply", " text"])).toBe("Reply text");
  });

  it("drops reasoning that never closes", () => {
    expect(run(["<think>still thinking"])).toBe("");
  });

  it("keeps a short reply that only looks like the start of a tag", () => {
    expect(run(["<th"])).toBe("<th");
    expect(run(["  "])).toBe("  ");
  });
});
