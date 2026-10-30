import "server-only";
import { BRIEF_RESULTS_PER_TOPIC, RESEARCH_MAX_RESULTS, RESEARCH_PAGES } from "@/lib/limits";
import type { ChatStreamEvent } from "@/types/api";
import type { SpendGuard } from "@/server/db/spend";
import type { Logger } from "@/server/log";
import { ProviderError } from "@/server/providers/errors";
import type { PageText, SearchOptions, WebSearchResult } from "@/server/providers/tavily/client";
import { TAVILY_EXTRACT_CREDITS } from "./spend";

/** Tavily calls for deep research and the morning brief (decision 0018). Null when Tavily is not set up. */
export interface ResearchServices {
  search(query: string, options: Pick<SearchOptions, "depth" | "topic" | "timeRange" | "maxResults">, signal: AbortSignal): Promise<WebSearchResult[]>;
  extract(urls: string[], signal: AbortSignal): Promise<PageText[]>;
}

export interface ResearchContext {
  research: ResearchServices;
  spend: SpendGuard;
  log: Logger;
  waitUntil: (work: Promise<unknown>) => void;
  requestId: string;
  /** Tavily credits held before the stream, in the order of use. A credit leaves when its search starts. */
  credits: string[];
  signal: AbortSignal;
}

const NEWS_WORDS =
  /\b(news|latest|today|tonight|yesterday|this (week|month|year)|recent(ly)?|breaking|just (announced|released)|update[sd]?|announce[sd]?|election|20\d\d)\b/i;

/** True when the question is about recent events, so the search uses Tavily's news topic. */
export function wantsNews(query: string): boolean {
  return NEWS_WORDS.test(query);
}

function aborted(signal: AbortSignal): void {
  if (signal.aborted) throw new ProviderError("tavily", "aborted");
}

/**
 * One advanced search, then the text of the top RESEARCH_PAGES pages. The
 * search credit was held before the stream; the extract credit is held here,
 * just before the extract. A refused or failed extract leaves the excerpts.
 */
export async function* deepResearch(
  context: ResearchContext,
  query: string,
): AsyncGenerator<ChatStreamEvent, WebSearchResult[]> {
  const { research, spend, signal } = context;
  aborted(signal);
  yield { type: "status", tool: "research_search", query };
  context.credits.shift();
  const results = await research.search(
    query,
    { depth: "advanced", maxResults: RESEARCH_MAX_RESULTS, ...(wantsNews(query) ? { topic: "news" as const } : {}) },
    signal,
  );
  if (results.length === 0) return results;

  const top = results.slice(0, RESEARCH_PAGES);
  const credit = await spend.reserve("tavily", TAVILY_EXTRACT_CREDITS);
  if (!credit.allowed) {
    context.log("warn", "spend_limit_reached", { requestId: context.requestId, route: "chat", provider: "tavily", limit: credit.limit, stage: "extract" });
    return results;
  }
  let pages: PageText[] = [];
  let sent = false;
  try {
    aborted(signal);
    yield { type: "status", tool: "research_read", count: top.length };
    sent = true;
    pages = await research.extract(
      top.map((result) => result.url),
      signal,
    );
  } catch (error) {
    if (signal.aborted) throw error;
    context.log("warn", "extract_failed", {
      requestId: context.requestId,
      route: "chat",
      kind: error instanceof ProviderError ? error.kind : "unknown",
    });
  } finally {
    // An extract that was sent keeps its credit. One that was not sent is settled at 0.
    if (!sent) {
      const giveBack = spend.settle(credit.id, 0).catch(() => {
        context.log("warn", "spend_settle_failed", { requestId: context.requestId, route: "chat", provider: "tavily" });
      });
      context.waitUntil(giveBack);
      await giveBack;
    }
  }
  const textByUrl = new Map(top.map((result) => [result.url, pages.find((page) => page.url === result.url)?.text]));
  return results.map((result) => {
    const pageText = textByUrl.get(result.url);
    return pageText ? { ...result, pageText } : result;
  });
}

/**
 * One news search of the last day for each topic that has a held credit. A
 * failed topic is skipped. When every topic fails, the last error is thrown,
 * so the reply says that search failed.
 */
export async function* briefSearch(
  context: ResearchContext,
  topics: string[],
): AsyncGenerator<ChatStreamEvent, WebSearchResult[]> {
  const { research, signal } = context;
  const found: WebSearchResult[] = [];
  let lastError: unknown = null;
  let succeeded = 0;
  for (const topic of topics) {
    aborted(signal);
    yield { type: "status", tool: "brief_search", query: topic };
    context.credits.shift();
    try {
      const results = await research.search(topic, { topic: "news", timeRange: "day", maxResults: BRIEF_RESULTS_PER_TOPIC }, signal);
      succeeded += 1;
      for (const result of results) {
        if (!found.some((known) => known.url === result.url)) found.push(result);
      }
    } catch (error) {
      if (signal.aborted) throw error;
      lastError = error;
      context.log("warn", "search_failed", {
        requestId: context.requestId,
        route: "chat",
        stage: "brief",
        kind: error instanceof ProviderError ? error.kind : "unknown",
      });
    }
  }
  if (succeeded === 0 && lastError) throw lastError;
  return found;
}
