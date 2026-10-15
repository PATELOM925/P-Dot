import { describe, expect, it, vi } from "vitest";
import { SEARCH_EXCERPT_CHARS, SEARCH_QUERY_CHARS } from "@/lib/limits";
import { ProviderError } from "@/server/providers/errors";
import { searchWeb } from "@/server/providers/tavily/client";

const settings = { apiKey: "tvly-test" };

function jsonFetch(body: unknown, status = 200) {
  return vi.fn<typeof fetch>(async () => Response.json(body, { status }));
}

describe("searchWeb", () => {
  it("sends a bounded basic search with the API key as a bearer token", async () => {
    const fetchImpl = jsonFetch({ results: [] });
    await searchWeb(settings, `  ${"q".repeat(SEARCH_QUERY_CHARS + 50)}  `, { fetchImpl });

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.tavily.com/search");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer tvly-test");
    const body = JSON.parse(String(init?.body));
    expect(body.query.length).toBeLessThanOrEqual(SEARCH_QUERY_CHARS);
    expect(body).toMatchObject({ search_depth: "basic", max_results: 5, include_answer: false, include_raw_content: false });
  });

  it("keeps only safe, unique http(s) results and truncates excerpts", async () => {
    const fetchImpl = jsonFetch({
      results: [
        { title: "Good", url: "https://example.com/a", content: "x".repeat(SEARCH_EXCERPT_CHARS + 100), score: 0.9 },
        { title: "Duplicate", url: "https://example.com/a", content: "dup" },
        { title: "Script", url: "javascript:alert(1)", content: "bad" },
        { title: "", url: "http://untitled.example/", content: "  spaced\n\n out  " },
        { title: "Empty", url: "https://empty.example/", content: "" },
      ],
    });
    const results = await searchWeb(settings, "query", { fetchImpl });

    expect(results.map((r) => r.url)).toEqual(["https://example.com/a", "http://untitled.example/"]);
    expect(results[0]!.excerpt.length).toBeLessThanOrEqual(SEARCH_EXCERPT_CHARS);
    expect(results[1]).toEqual({ title: "untitled.example", url: "http://untitled.example/", excerpt: "spaced out" });
  });

  it.each([
    [401, "auth"],
    [429, "rate_limited"],
    [432, "quota"],
    [500, "unavailable"],
  ])("maps HTTP %i to %s", async (status, kind) => {
    const error = await searchWeb(settings, "q", { fetchImpl: jsonFetch({ detail: "x" }, status) }).catch((e) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ provider: "tavily", kind, status });
  });

  it("rejects responses that do not match the documented shape", async () => {
    const error = await searchWeb(settings, "q", { fetchImpl: jsonFetch({ unexpected: true }) }).catch((e) => e);
    expect(error).toMatchObject({ kind: "bad_response" });
  });

  it("times out", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    const error = await searchWeb(settings, "q", { fetchImpl, timeoutMs: 20 }).catch((e) => e);
    expect(error).toMatchObject({ kind: "timeout" });
  });
});
