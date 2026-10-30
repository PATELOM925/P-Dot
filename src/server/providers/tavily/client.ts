import "server-only";
import { z } from "zod";
import {
  RESEARCH_MAX_RESULTS,
  RESEARCH_PAGE_CHARS,
  RESEARCH_PAGES,
  SEARCH_EXCERPT_CHARS,
  SEARCH_MAX_RESULTS,
  SEARCH_QUERY_CHARS,
} from "@/lib/limits";
import { toSafeHttpUrl } from "@/lib/safe-url";
import { createAbortScope, discardBody, kindFromStatus, ProviderError } from "../errors";

// https://docs.tavily.com/documentation/api-reference/endpoint/search
// https://docs.tavily.com/documentation/api-reference/endpoint/extract

const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
const TAVILY_EXTRACT_URL = "https://api.tavily.com/extract";
export const TAVILY_TIMEOUT_MS = 10_000;

export interface WebSearchResult {
  title: string;
  url: string;
  /** Untrusted text retrieved from the web page. */
  excerpt: string;
  /** Untrusted text of the whole page, from an extract (deep research only). */
  pageText?: string;
}

export interface SearchOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxResults?: number;
  /** "advanced" costs 2 credits, "basic" 1 (decision 0006). */
  depth?: "basic" | "advanced";
  topic?: "general" | "news";
  timeRange?: "day";
}

export interface PageText {
  url: string;
  /** Untrusted page text, at most RESEARCH_PAGE_CHARS characters. */
  text: string;
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
  const depth = options.depth ?? "basic";
  const limit = depth === "advanced" ? RESEARCH_MAX_RESULTS : SEARCH_MAX_RESULTS;
  const maxResults = Math.min(options.maxResults ?? SEARCH_MAX_RESULTS, limit);
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
          search_depth: depth,
          max_results: maxResults,
          ...(options.topic ? { topic: options.topic } : {}),
          ...(options.timeRange ? { time_range: options.timeRange } : {}),
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

const extractSchema = z.object({
  results: z.array(z.object({ url: z.string(), raw_content: z.string().nullish() })),
});

/**
 * The text of at most RESEARCH_PAGES pages, each cut to RESEARCH_PAGE_CHARS.
 * Basic depth costs 1 credit for each 5 pages that succeed. A page that fails
 * or is empty is left out. Only pages in `urls` come back.
 */
export async function extractPages(
  settings: { apiKey: string },
  urls: string[],
  options: Omit<SearchOptions, "maxResults" | "depth" | "topic" | "timeRange"> = {},
): Promise<PageText[]> {
  const asked = [...new Set(urls.map((url) => toSafeHttpUrl(url)).filter((url): url is string => url !== null))].slice(
    0,
    RESEARCH_PAGES,
  );
  if (asked.length === 0) return [];
  const fetchImpl = options.fetchImpl ?? fetch;
  const scope = createAbortScope({ totalMs: options.timeoutMs ?? TAVILY_TIMEOUT_MS, parent: options.signal });
  try {
    let response: Response;
    try {
      response = await fetchImpl(TAVILY_EXTRACT_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${settings.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ urls: asked, extract_depth: "basic", format: "text", include_images: false }),
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
    let body: z.infer<typeof extractSchema>;
    try {
      body = extractSchema.parse(await response.json());
    } catch {
      if (options.signal?.aborted) throw new ProviderError("tavily", "aborted");
      if (scope.timedOut()) throw new ProviderError("tavily", "timeout");
      throw new ProviderError("tavily", "bad_response");
    }
    const pages: PageText[] = [];
    for (const item of body.results) {
      const url = toSafeHttpUrl(item.url);
      if (!url || !asked.includes(url) || pages.some((page) => page.url === url)) continue;
      const text = clean(item.raw_content ?? "", RESEARCH_PAGE_CHARS);
      if (text) pages.push({ url, text });
      if (pages.length >= RESEARCH_PAGES) break;
    }
    return pages;
  } finally {
    scope.dispose();
  }
}
