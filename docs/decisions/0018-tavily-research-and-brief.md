# 0018: Deep research and the morning brief

- Status: Proposed (2026-10-30).
- Related: [0006 spend guard](0006-global-spend-guard.md), [0013 tools](0013-ai-tools-and-scope.md), [0017 rich answers](0017-rich-answers.md).
- Code: `src/server/assistant/research.ts`, `src/server/providers/tavily/client.ts`, `src/server/assistant/service.ts` (`prepareChatTurn`, `runChatTurn`), `src/server/assistant/prompt.ts`, `src/features/today/BriefCard.tsx`, `src/features/chat/composer-sources.ts`.

## Problem

Web search in P-Dot is one basic Tavily search with 5 short excerpts. For a question that needs a comparison, the excerpts are too short, and the reply has no fixed shape. The Today page had a "Daily brief" panel with no function.

## High-level design

Both features are kinds of web retrieval inside the existing chat turn. They use the route `/api/chat`, the quota, the Nebius hold, the reply claim, the saved messages and the "What was sent" record that chat already has. There is no new route, no new table and no migration.

| | Deep research | Morning brief |
| --- | --- | --- |
| Start | "Deep research" in the "+" menu, for one message | "Make today's brief" on the Today page. Only a click starts it. |
| Tavily | 1 `/search`, `search_depth: "advanced"`, up to 8 results, `topic: "news"` when the question is about recent events. Then 1 `/extract` of the top 3 pages. | 1 `/search` for each topic (1 to 3), `topic: "news"`, `time_range: "day"`, 3 results each. |
| Credits held | 2 before the stream, then 1 just before the extract | 1 for each topic, before the stream |
| Reply | A short answer, "Key findings" with `[n]`, "What sources disagree on", "Limits". It can add one `pdot-table` or `pdot-checklist`. | 5 bullets with `[n]` |
| Saved as | A reply in the current conversation | A new conversation, "Brief for <local date>" |
| Status lines | "Searching the web (deep)…", "Reading 3 pages…", "Writing the brief…" | "Searching today's news for “topic”…", "Writing the brief…" |

Deep research and the brief are exclusive with Google and connected apps, like web search. The brief also takes no web search and no conversation ID.

## Low-level design

- **Request.** `ChatRequest` gets `research?: true` (send and retry) and `brief?: { topics, date }` (send only). The schema refuses research without `webSearch`, and a brief with web search, research, Google, apps or a conversation ID. Topics: 1 to 3, each 1 to 60 characters. Date: at most 40 letters, digits, spaces and `,./-`.
- **Retrieval kind.** `prepareChatTurn` sets `retrieval` to `basic`, `deep`, `brief` or null, before the hold. Without the research services (Tavily not set up), deep falls back to basic, and a brief says that search is not set up. The `web_search` tool is offered only with `basic`.
- **Tier.** Deep research and the brief run on the standard tier at least, like a turn with tools. "Think harder" keeps the heavy tier.
- **Nebius hold.** The first hold adds the worst-case bytes of the retrieval: `RESEARCH_RESULTS_MAX_BYTES` (8 results and 3 pages of 3,000 characters, 4 bytes for each character) or `BRIEF_RESULTS_MAX_BYTES` (9 results). The bounds are in `spend.ts`, the one owner of holds. The largest deep research turn on the heavy tier (full history, 3-byte characters, 8,192 output tokens) holds less than the $0.25 ceiling, and at least the cost of its final prompt (`tests/unit/spend-guard.test.ts`).
- **Tavily holds.** One reservation can hold at most 2 credits (SQL bound), so each search has its own reservation. `TurnHolds.tavily` is a list, in the order of use. A credit leaves the list when its search starts, so a search that was sent keeps its credit and `releaseTurn` gives back only unsent ones. The extract credit is reserved in the stream. If Stop comes before the extract is sent, it is settled at 0. A refused extract credit leaves the excerpts, and the reply goes on. If the first credit is refused, the turn answers without web sources and shows the search limit message (decision 0006).
- **Brief topics.** A topic whose credit is refused is not searched. A topic whose search fails is skipped. When every topic fails, the turn shows that search failed.
- **Pricing (Tavily docs, 2026-10-30).** Basic search: 1 credit. Advanced search: 2 credits. `topic` and `time_range` do not change the cost. Basic extract: 1 credit for each 5 successful URLs; a failed URL costs nothing. P-Dot holds 1 credit for an extract of at most 3 pages and keeps it when the extract was sent.
- **Untrusted text.** Page text goes into the same `<web_search_results>` block as excerpts, in the final user turn, as `Page text:` after the excerpt of its source. `neutralize` removes every delimiter tag from it. The system message gets only P-Dot's own format rules. Each page is cut to 3,000 characters, and at most 3 pages are read, so a turn has at most 9,000 characters of page text. The extract adapter keeps only pages that it asked for.
- **Status events.** `{ type: "status", tool, query?, count? }` gets the steps `research_search`, `research_read` (with `count`), `research_write` and `brief_search`. They are not tools and are never saved. An older page shows "P-Dot is using a tool…" for them.
- **The brief conversation.** The Today page sends `{ action: "send", mode, message, webSearch: false, brief }`. The server titles the new conversation `Brief for <date>` and makes no model title. The reply, its sources and its context record are saved like any reply, so "Open in chat" shows it with "What was sent".
- **Topics.** The Topics field is in `localStorage`, one key for each mode (`pdot.brief.topics.<mode>`). When it is empty, the page fills it with the text of up to 3 active memories of the mode, cut to 60 characters. The user sees the topics before the click, and the card says that each topic goes to the web search provider.
- **Logs.** `extract_failed` and `search_failed` (stage `brief`) carry only the error kind. Never a query, a topic or page text.

## What this leaves out

- Server-side topic choice from memories, and a brief that runs on a schedule. Both need a decision on what P-Dot may send to Tavily without a click.
- "Retry reply" after a brief is a normal retry: it does not run the topic searches again. "Retry reply" after deep research runs deep research only if "Deep research" is on again.
- Advanced extract, `include_answer` and the Tavily `/research` endpoint.
- The model can still write fewer than 5 bullets or skip a section. The format is a prompt rule, not a check.

## Limits

- The news topic is chosen by a word list (`wantsNews`), not by the model.
- The date in the title comes from the browser. The server checks only its characters and length.
- Deep research on the heavy tier can be above a trial user's daily Nebius cap; the turn then gets `budget_exhausted` before any call.
