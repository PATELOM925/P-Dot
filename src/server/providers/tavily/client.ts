import "server-only";
import { z } from "zod";
import { SEARCH_EXCERPT_CHARS, SEARCH_MAX_RESULTS, SEARCH_QUERY_CHARS } from "@/lib/limits";
import { toSafeHttpUrl } from "@/lib/safe-url";
import { createAbortScope, discardBody, kindFromStatus, ProviderError } from "../errors";

// https://docs.tavily.com/documentation/api-reference/endpoint/search

const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
export const TAVILY_TIMEOUT_MS = 10_000;

export interface WebSearchResult {
  title: string;
  url: string;
  /** Untrusted text retrieved from the web page. */
  excerpt: string;
}

export interface SearchOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxResults?: number;
}

const responseSchema = z.object({
  results: z.array(
    z.object({
      title: z.string().nullish(),
      url: z.string(),
      content: z.string().nullish(),
    }),
  ),
});

function clean(text: string, maxChars: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > maxChars ? `${collapsed.slice(0, maxChars - 1).trimEnd()}…` : collapsed;
}

export async function searchWeb(
  settings: { apiKey: string },
  query: string,
  options: SearchOptions = {},
): Promise<WebSearchResult[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxResults = Math.min(options.maxResults ?? SEARCH_MAX_RESULTS, SEARCH_MAX_RESULTS);
  const scope = createAbortScope({ totalMs: options.timeoutMs ?? TAVILY_TIMEOUT_MS, parent: options.signal });

  try {
    let response: Response;
    try {
      response = await fetchImpl(TAVILY_SEARCH_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${settings.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: clean(query, SEARCH_QUERY_CHARS),
          search_depth: "basic",
          max_results: maxResults,
          include_answer: false,
          include_raw_content: false,
          include_images: false,
        }),
        signal: scope.signal,
      });
    } catch {
      if (options.signal?.aborted) throw new ProviderError("tavily", "aborted");
      throw new ProviderError("tavily", scope.timedOut() ? "timeout" : "unavailable");
    }

    if (!response.ok) {
      await discardBody(response);
      throw new ProviderError("tavily", kindFromStatus(response.status), response.status);
    }

    let body: z.infer<typeof responseSchema>;
    try {
      body = responseSchema.parse(await response.json());
    } catch {
      if (options.signal?.aborted) throw new ProviderError("tavily", "aborted");
      if (scope.timedOut()) throw new ProviderError("tavily", "timeout");
      throw new ProviderError("tavily", "bad_response");
    }

    const seen = new Set<string>();
    const results: WebSearchResult[] = [];
    for (const item of body.results) {
      const url = toSafeHttpUrl(item.url);
      if (!url || seen.has(url)) continue;
      const excerpt = clean(item.content ?? "", SEARCH_EXCERPT_CHARS);
      if (!excerpt) continue;
      seen.add(url);
      results.push({
        title: clean(item.title || new URL(url).hostname, 200),
        url,
        excerpt,
      });
      if (results.length >= maxResults) break;
    }
    return results;
  } finally {
    scope.dispose();
  }
}
