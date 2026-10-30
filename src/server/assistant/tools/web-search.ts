import "server-only";
import { z } from "zod";
import { SEARCH_QUERY_CHARS } from "@/lib/limits";
import { ProviderError } from "@/server/providers/errors";
import { formatSearchResults } from "../prompt";
import { TAVILY_BASIC_SEARCH_CREDITS } from "../spend";
import type { ToolSpec } from "./registry";

const args = z.object({
  query: z.string().trim().min(1).max(SEARCH_QUERY_CHARS).describe("The search words."),
});

/**
 * One more web search in a turn where the user turned on search. Each search
 * holds one Tavily credit first; a search that was sent keeps its credit
 * (decision 0006).
 */
export const webSearchTool: ToolSpec<z.infer<typeof args>> = {
  name: "web_search",
  description: "Search the web for current information. Use it only when the results already given do not answer the question.",
  args,
  kind: "read",
  guidance:
    "web_search: the user turned on web search for this message, and results for the message are already attached. Call web_search only when you need one more search with a different query. You can call it once.",
  maxCallsPerTurn: 1,
  offered: (flags) => flags.webSearch,
  statusQuery: ({ query }) => query,
  async run({ query }, context) {
    const { services, signal } = context;
    if (!services.search) return { content: "Web search is not available. Answer without new web sources." };
    const credit = await services.spend.reserve("tavily", TAVILY_BASIC_SEARCH_CREDITS);
    if (!credit.allowed) {
      services.log("warn", "spend_limit_reached", {
        requestId: context.requestId,
        route: "chat",
        provider: "tavily",
        limit: credit.limit,
        stage: "tool",
      });
      return { content: "Web search was not used: P-Dot reached its search limit. Answer without new web sources." };
    }
    let results;
    try {
      results = await services.search(query, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      services.log("warn", "search_failed", {
        requestId: context.requestId,
        route: "chat",
        stage: "tool",
        kind: error instanceof ProviderError ? error.kind : "unknown",
      });
      return { content: "Web search failed. Answer without new web sources, and say so." };
    }
    const known = new Set(context.sources.map((source) => source.url));
    const fresh = results.filter((result) => !known.has(result.url));
    if (fresh.length === 0) return { content: "Web search found no new usable results." };
    return { content: formatSearchResults(fresh, context.sources.length + 1), sources: fresh };
  },
};
