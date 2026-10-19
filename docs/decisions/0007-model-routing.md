# 0007: Model routing with fallbacks, retries and a hedge

- Status: Proposed (2026-10-19). The owner accepts it when the pull request is merged.
- Code: `src/server/assistant/router.ts`, `tiers.ts`, `executor.ts`, `breaker.ts`, `src/server/providers/model.ts`, `src/lib/routing.ts`, `supabase/migrations/20261019120000_message_routing.sql`.

## Problem

Before this change, every message went to one model (Nemotron 3 Super). A short "thanks" cost the same as a hard planning question. A hard question got no extra reasoning. One slow or failed Nebius call became an error for the user, with no retry and no second model.

Nebius gives this guidance: use Nemotron 3 Ultra for serious reasoning, and Nano or Super for fast, everyday calls. The owner has a $25 Nebius credit, and the spend guard ([decision 0006](0006-global-spend-guard.md)) caps spend.

## Decision

### Tiers

| Tier | Models, in order | Reasoning | Max output tokens | First-token timeout | Deadline | Hedge |
| --- | --- | --- | --- | --- | --- | --- |
| `fast` | Nemotron 3.5 Lightning → Nemotron 3 Nano → Nemotron 3 Super | Off | 1,024 | 5 s | 60 s | After 1.5 s |
| `standard` | Nemotron 3 Super → Nemotron 3.5 Lightning | Off | 2,048 | 10 s | 90 s | Never |
| `heavy` | Nemotron 3 Ultra → Nemotron 3 Super | On, 1,024-token budget | 4,096 (1,024 reasoning + at least 3,072 reply) | 15 s | 150 s | Never |
| `vision` | Nemotron 3.5 Super VL (no fallback) | Off | 1,024 | 10 s | 60 s | Never |

The `vision` tier has no image input in the chat API yet. It is the hook for image input later (`hasImage` in the router). Without a second vision model, a failure is an error, not a text-only reply.

### Router

A pure function (`routeRequest`) picks the tier. It makes no model call, so it adds no time. The first rule that matches wins:

| Rule | Tier | Reason code | Label under the reply |
| --- | --- | --- | --- |
| A caller asks for a tier (the agent loop, later) | that tier | `requested` | requested by the assistant |
| Image input | vision | `image` | image input |
| The user chose "Think harder" (`effort: "deep"`) | heavy | `user_deep` | you asked to think harder |
| Two or more reasoning signals, or a list of 3+ steps or 3+ questions | heavy | `multi_step` | multi-step request |
| One signal in a message of 1,200+ characters | heavy | the signal | for example "analysis or comparison" |
| One signal | standard | `planning`, `analysis`, `math` or `code` | for example "planning request" |
| Message of 1,200+ characters | standard | `long_message` | long message |
| Earlier conversation of 16,000+ characters | standard | `long_context` | long conversation |
| Web search on | standard | `web_search` | web search results |
| Anything else | fast | `everyday` | everyday request |

Signals are short keyword and structure patterns (in `router.ts`): planning ("plan a", "itinerary", "step by step"), analysis ("compare", "pros and cons", "difference between", "explain why"), math (an operator between numbers, "solve", "calculate", "prove") and code (code fences, "debug", language names, code syntax). The unit tests have more than 40 example prompts.

The agent loop can call `routeRequest({ ..., requestedTier: "heavy" })` for planning steps and `"fast"` for tool-argument filling, or call the executor with `routing[tier]` directly.

### Executor

`executeRouted` runs one reply on a tier's chain. It uses only the `ModelProvider` interface, and Nebius is the adapter under it.

- **Commit point.** An attempt can be retried or replaced only before the first visible token goes to the user. After that, the executor never switches models. An error goes to the user as before.
- **Errors.**
  - Retry: network errors, timeouts, an error in the stream before the first token, and HTTP 408, 409, 425, 429 and 5xx.
  - Next model, no retry: 404 (for example an unknown model ID).
  - Stop: 400, 401, 403, 413, 422 and account quota errors. Another model would fail the same way.
  - An empty reply (finished with no visible text): next model.
  - The same rules apply to an error event inside the stream. Its numeric `code` (or a numeric string) is kept as the status. A known OpenAI-compatible label in `error.code` or `error.type` decides first, from the stream or from a JSON error body (read up to 8 KB and never logged). Quota or billing labels stop every model, even with HTTP 429, and the user sees "The AI provider account for P-Dot has reached its limit." Authentication labels stop. `model_not_found` goes to the next model. Rate-limit, server and overloaded labels are retried.
- **Retries.** At most 2 tries on each model, then the next model. The wait before a retry uses full jitter: a random time from 0 to min(2 s, 200 ms × 2^(try − 1)). If the provider sends `Retry-After` of 2 s or less, the executor waits at least that long. If it is longer, the executor goes to the next model at once. Each model has its own earliest next-try time. A failure on another model (for example the hedge) never shortens it, and a hedge never starts on a model that is still waiting.
- **First-token timeout.** Each attempt must send a token (reply text or reasoning) within the tier's timeout. If not, it stops, and the next model starts.
- **Deadline.** One deadline covers all attempts and the streaming of the reply. No attempt starts with less than 1 s left.
- **Attempt cap.** At most 4 attempts for `fast`, 3 for `standard` and `heavy`, and 2 for `vision`, with the hedge included.
- **Hedge (fast tier only).** If no token has come 1.5 s after the first attempt started, one parallel attempt starts on the next model. The first attempt to send a token wins, and the other stops at once. A request gets at most one hedge. The measured time to the first token is 0.3 to 0.9 s, so 1.5 s is above the usual time. Standard and heavy calls cost more, so they are never hedged.
- **Breaker.** After 3 failures in a row, a model is skipped for 30 s. After that, the next request tries it again, and one success resets the count. If all models of a tier are skipped, the executor tries them anyway. **Best effort:** the state is in the memory of one Workers isolate. Isolates do not share it, and it is lost when an isolate is recycled. It is not a limit and holds no data.
- **Stop and disconnect.** The user's abort stops every attempt, the hedge included.

### Reasoning

All four text models accept `chat_template_kwargs: { enable_thinking: false }`, and then they make 0 reasoning tokens. Nebius also accepts `thinking_token_budget`. These real calls were made on 2026-10-19:

| Model | Request | Reasoning tokens | Reply |
| --- | --- | --- | --- |
| Super | thinking on, no budget | 185 | correct |
| Super | thinking on, `chat_template_kwargs.reasoning_budget: 24` | 185 (not read) | correct |
| Super | thinking on, `thinking_token_budget: 24` | 23 | correct |
| Ultra | thinking on, `thinking_token_budget: 128` | 127 | correct |
| Nano | thinking on, `thinking_token_budget: 64` | cut at the budget | not empty |

So the heavy tier turns reasoning on with a 1,024-token budget, and its output limit leaves at least 512 tokens for the reply (the config refuses less). Reasoning is billed as output. It is never shown or saved. A reasoning delta counts as the first token for the timeout, so a thinking model is not stopped. If a reply is still empty, the executor tries the next model. The other tiers keep reasoning off, because it adds time before the first word and can leave an empty reply on small models.

### Spend guard

Each attempt (retries, fallbacks and the hedge included) holds spend before it starts and settles after it ends:

- The hold made before streaming (which can return HTTP 429 or 503 with `budget_exhausted`) pays for the first attempt. It is priced for the most expensive model in the tier, because the breaker can skip the first one.
- Each later attempt holds the worst case for its model and the real prompt.
- Settle: the real cost when valid usage arrived. Otherwise the full hold stays counted: for an error, a timeout, a stopped hedge loser, Stop or disconnect. The hold goes back only when no provider call was sent (for example Stop during web search).
- If the budget refuses a retry or a fallback, the reply stops with `budget_exhausted` ("P-Dot has reached its daily usage limit…"). If it refuses a hedge, the first attempt goes on alone.
- Every model in a chain must have a price. An unpriced model is a config error (chat says "not configured"). The chain never skips it silently.

The attempt cap and the deadline limit how many holds one reply can make.

### Before the migration is applied

A merge to `main` applies the migration and deploys the Worker at about the same time, so the new code can run first. When the database says that a route column does not exist (Postgres `42703` or PostgREST `PGRST204`, naming only `model`, `model_tier`, `route_reason` or `model_fallback`), the repository repeats the statement with the old columns. Replies then have `route: null`, and nothing else changes. A missing column fails the statement before any row is written, so the repeated insert cannot make a duplicate. Each request makes a new repository, so the fallback ends as soon as the migration is applied. Other database errors still fail closed.

### What the user sees

- The `start` event has `route: { tier, reason }`. The `done` event's message, and each assistant message in the conversation history, has `route: { model, tier, reason, fallback }`, or `null` for replies saved before this change.
- A small line under each reply, for example "Nemotron 3 Super · multi-step request", with "after fallback" when a later model answered.
- The composer has an "Auto / Think harder" switch. "Think harder" sends `effort: "deep"`, so the reply always uses the heavy tier. It stays on until the user changes it.

### Logs

One `model_route` line for each reply, with metadata only: tier, reason, the models tried (`a>b`), attempts, `hedgeFired`, `hedgeWon`, `breakerSkips`, model, `fallback`, `firstTokenMs`, `totalMs` and outcome (`ok`, `error`, `aborted`, `timeout`, `budget`, `empty` or `stopped`). No prompt or reply text.

## Cost for each tier

Prices per million tokens, input / output: Lightning and Nano $0.06 / $0.24, Super and Super VL $0.30 / $0.90, Ultra $1.00 / $3.00.

| Tier | A typical reply (1,500 tokens in, 300 out) | A large reply (6,000 in, full output limit) | Typical replies for $1 |
| --- | --- | --- | --- |
| fast (Lightning) | $0.00016 | $0.0006 | about 6,000 |
| standard (Super) | $0.00072 | $0.0036 | about 1,400 |
| heavy (Ultra, with up to 1,024 reasoning tokens) | $0.0055 | $0.018 | about 180 |
| vision (Super VL) | $0.00072 | $0.0027 | about 1,400 |

Before this change, every reply cost the "standard" price. A hedge adds at most one more fast-tier call. The loser stops early, so its real cost is small, but the guard counts its full hold (the safe side).

## Measured (2026-10-19, small sample, through the executor, `max_tokens` 400)

| Tier and model | First visible token | Whole reply |
| --- | --- | --- |
| fast, Lightning (2 replies) | 431 and 467 ms | 478 and 488 ms |
| standard, Super (2) | 502 and 530 ms | 695 and 713 ms |
| heavy, Ultra, reasoning budget 200 (2) | 559 and 869 ms | 916 and 1,057 ms |
| vision, Super VL (1) | 495 ms | 598 ms |
| fast, unknown model then Lightning (1) | 338 ms | 342 ms |

The unknown model ID returned 404, and the executor went to Lightning without a retry (2 attempts). No hedge fired. These calls were made at a quiet time and are not a p95. Watch `firstTokenMs` in the `model_route` logs after the deploy.

## How to change it

- Model chains and output limits: `NEBIUS_FAST_MODELS`, `NEBIUS_STANDARD_MODELS`, `NEBIUS_HEAVY_MODELS`, `NEBIUS_VISION_MODELS` (1 to 4 IDs, comma-separated), `NEBIUS_MAX_OUTPUT_TOKENS` (fast and vision), `NEBIUS_STANDARD_MAX_OUTPUT_TOKENS`, `NEBIUS_HEAVY_MAX_OUTPUT_TOKENS`, `NEBIUS_HEAVY_THINKING_BUDGET` (0 turns reasoning off) and `NEBIUS_HEDGE_AFTER_MS` (0 turns the hedge off). Change them in `wrangler.jsonc`, in both `vars` and `previews.vars`, through a pull request. A new model also needs a price in `src/server/providers/nebius/pricing.ts`.
- Timeouts, deadlines, tries, attempt caps and backoff: `src/server/assistant/tiers.ts`.
- Router rules and keywords: `src/server/assistant/router.ts`, with tests in `tests/unit/router.test.ts`.
- To send everything to one model, set all four chains to that model.

## What this does not do

- No model call to classify a message. The rules can choose wrong. "Think harder" is the user's way to override them.
- No image upload yet. The vision tier and the `hasImage` router input are ready for it.
- The breaker is per isolate and best effort. It is not a shared health check.
- No switch to another model after the first visible token. A stream that breaks in the middle is an error, and the user can retry.
- `NEBIUS_MODEL` is no longer read. It stays on the Worker env allow list, so an old `.env` file does not stop a deploy.
