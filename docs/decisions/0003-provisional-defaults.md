# 0003 — Provisional implementation defaults (needs review)

- Status: Proposed. These were chosen to make the MVP runnable; none has been approved as a product requirement.

| Area | Current default | Where |
| --- | --- | --- |
| Usage limit | 30 chat requests per user per hour (fixed window); retries count | `CHAT_REQUESTS_PER_WINDOW`, `CHAT_WINDOW_SECONDS` |
| Spend caps (all users) | Nebius $1.00 a day, $20.00 in total, $0.25 a user a day; Tavily 40 credits a day, 800 a month, 10 a user a day. Accepted in [decision 0006](0006-global-spend-guard.md) | `NEBIUS_*_CAP_USD`, `TAVILY_*_CREDITS` |
| Model | `nvidia/nemotron-3-super-120b-a12b`, reasoning off (`enable_thinking: false`) | `NEBIUS_MODEL` in `wrangler.jsonc` |
| Reply length | 1,024 output tokens; hard stop at 30,000 characters | `NEBIUS_MAX_OUTPUT_TOKENS`, `src/lib/limits.ts` |
| Message size | 4,000 characters; 16 KB request body | `src/lib/limits.ts` |
| Context budget | Last 40 stored messages, trimmed to ~24,000 characters (~6k tokens), oldest dropped first | `src/lib/limits.ts`, `src/server/assistant/context.ts` |
| Web search | Tavily `basic` depth, max 5 results, 1,200-character excerpts, query is the user's message (≤400 chars) | `src/server/providers/tavily/client.ts` |
| Search toggle | Off by default; stays on for later messages until the user turns it off | `src/features/chat/ChatWorkspace.tsx` |
| Search failure | The reply is still generated; the user sees a notice and the model is told not to claim web grounding | `src/server/assistant/service.ts` |
| Rendering | Plain text (`white-space: pre-wrap`); no Markdown or HTML rendering | `src/features/chat/MessageView.tsx` |
| History | Reopening a conversation loads the latest 200 messages; list shows 50 conversations; no pagination | `src/lib/limits.ts` |
| Account deletion | Not implemented (conversation deletion is) | — |

Still open from the PRD: retention/backup policy, hosting region, audience size, and whether planning grows into tasks/reminders.
