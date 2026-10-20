# Provider reliability: retries, backups and spending

Read this before you change how P-Dot calls Nebius or Tavily. This includes model routing, retries, backup models, timeouts, the spend guard, usage parsing, and any migration that touches `messages`. It applies to people and to coding agents.

Each lesson below comes from a real defect. A reviewer found it or a measurement showed it on 2026-10-19. Each lesson has a rule and a source. The code is the source of truth for numbers: `src/server/assistant/tiers.ts`, `src/server/assistant/executor.ts`, `src/server/providers/nebius/pricing.ts`. Decisions: [0006 spend guard](decisions/0006-global-spend-guard.md), [0007 model routing](decisions/0007-model-routing.md).

## Rules (short form)

1. Every paid call reserves budget before it starts and settles after it ends. No exceptions, including retries, backup models and hedged requests.
2. A model without a known price is refused. Never guess a price.
3. Keep the full hold unless valid usage arrived. Invalid usage counts as missing usage. Never reduce a hold to fit the ceiling: refuse the call.
4. Retry only before the first visible token. After that, never switch models.
5. Keep retry state per model, as an absolute "not before" time. Never share one mutable wait between parallel attempts.
6. Classify provider errors by HTTP status and by error label. A quota or billing error stops all models, even when the status is 429.
7. Test error handling with raw wire data through the real adapter, not with tidy fakes.
8. A merge to `main` applies migrations and deploys code at about the same time. New code must work on the old schema.
9. Turn off model reasoning unless the tier needs it. If it is on, give it a budget and enough output tokens.
10. Process memory in a Worker is short-lived. Use it only for soft help, never for limits.

## Lessons

### 1. Reasoning tokens can leave the reply empty

- **What happened:** Nemotron models think before they answer by default. With `max_tokens` 80, Nemotron 3 Nano spent all 80 tokens on reasoning and returned an empty answer. Lightning did the same. Reasoning text arrives in `delta.reasoning` or `delta.reasoning_content`, not in `delta.content`. Reasoning tokens are billed as output tokens.
- **Fix:** Normal chat sends `chat_template_kwargs: { enable_thinking: false }`. All four Nemotron text models accept it, and the result has 0 reasoning tokens. The heavy tier keeps reasoning with `thinking_token_budget`. The routing PR checked that this field works on Super, Ultra and Nano. `chat_template_kwargs.reasoning_budget` is ignored.
- **Rule:** Never show or save reasoning text. If a tier turns reasoning on, set a budget well below its maximum output tokens.
- **Sources:** measurements on the owner's account, 2026-10-19 (summary in [PR #3](https://github.com/PATELOM925/P-Dot/pull/3)); [OpenAI-compatible chat API](https://platform.openai.com/docs/api-reference/chat/create); [Nebius Token Factory docs](https://docs.tokenfactory.nebius.com/).

### 2. A guessed price can let spending pass the cap

- **What happened:** The first spend guard used a fallback price ($1 in, $3 out per million tokens) for unknown models. The Nebius catalog has models that cost more. One is listed at $3 in and $15 out. With such a model, both the hold and the settle were too low, so real spending could pass the daily and total caps.
- **Fix:** No fallback price. `priceForModel()` returns a price or `null`. Config refuses a model without a price, and the error names the variable, not its value.
- **Rule:** To add a model, add its price from the catalog in the same pull request. Recheck prices before a demo or a judging period.
- **Sources:** [PR #2 review, round 1](https://github.com/PATELOM925/P-Dot/pull/2#issuecomment-6257586511); [Nebius public model catalog](https://tokenfactory.nebius.com/api/public/models_info).

### 3. Bad usage numbers must not make a reply free

- **What happened:** The usage parser clamped negative token counts to zero. A malformed final chunk could therefore settle a hold to $0 after a real reply. This was proved with a faked stream. Nebius has not been seen to send it.
- **Fix:** Usage is accepted only when both counts are non-negative safe integers. Anything else counts as missing usage, and the full hold stays.
- **Rule:** Treat provider usage as untrusted input. When in doubt, over-count.
- **Sources:** [PR #2 review, round 1](https://github.com/PATELOM925/P-Dot/pull/2#issuecomment-6257586511) and [round 2](https://github.com/PATELOM925/P-Dot/pull/2#issuecomment-6257656084); `stream_options.include_usage` in the [OpenAI-compatible chat API](https://platform.openai.com/docs/api-reference/chat/create).

### 4. A failed hedge reset the other model's retry wait

- **What happened:** The fast tier starts a second request (a hedge) on a backup model when the first token is late. Both attempts shared one `retryWait` value. The primary got 429 with `Retry-After: 2` at 1,600 ms. The hedge failed with 503 at 1,700 ms and overwrote the wait. The primary then retried at 1,700 ms instead of at 3,600 ms or later. Each early retry used budget and the attempt limit for nothing.
- **Fix:** Each model has its own absolute earliest next-try time. A failure on one model cannot shorten another model's wait. The executor checks the time whenever it picks a model. A hedge never starts on a model that is still waiting.
- **Rule:** Parallel attempts must not share mutable retry state. Honor `Retry-After` (seconds or HTTP date), with a cap. Use exponential backoff with full jitter. Hedge only the cheap tier, at most once, and cancel the loser at once.
- **Sources:** [PR #3 review, round 1](https://github.com/PATELOM925/P-Dot/pull/3#issuecomment-6257890039) and [fix](https://github.com/PATELOM925/P-Dot/pull/3#issuecomment-6257965012); [RFC 9110, Retry-After](https://www.rfc-editor.org/rfc/rfc9110#field.retry-after); [Exponential backoff and jitter (AWS)](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/); [The Tail at Scale (Dean and Barroso), on hedged requests](https://research.google/pubs/the-tail-at-scale/).

### 5. Error events inside the stream were misread

- **What happened:** Some errors arrive as server-sent events inside the stream, not as an HTTP status. The adapter lost the numeric code. An event with `code: 404` (model not found) stopped the reply instead of moving to the next model. An event labelled `insufficient_quota` was retried, but retrying cannot fix an empty account. The unit tests passed because they used tidy, already-normalized fake errors.
- **Fix:** Stream error events keep numeric codes. Error labels decide first:

  | Label or status | Action |
  | --- | --- |
  | quota or billing (even with 429) | stop all models; tell the user the provider account reached its limit |
  | authentication (401, 403) | stop |
  | `model_not_found`, 404 | next model, no retry |
  | rate limit (429), 408, 409, 425, 500, 502, 503, 504, overloaded | retry with backoff |
  | 400, 413, 422 | stop |

  Labels are also read from HTTP error bodies. The reader stops at about 8,192 characters. It checks the length after each chunk, so one large chunk can go over that number. The body is never logged.
- **Rule:** Test with raw wire data (SSE lines, real error bodies) through the real adapter and the executor together.
- **Limit:** These fixtures prove how our code reads those shapes. They do not prove that Nebius sends them. Record any real Nebius error shape you see in this file.
- **Sources:** [PR #3 review, round 1](https://github.com/PATELOM925/P-Dot/pull/3#issuecomment-6257890039) and [fix](https://github.com/PATELOM925/P-Dot/pull/3#issuecomment-6257965287); [OpenAI API error codes](https://platform.openai.com/docs/guides/error-codes).

### 6. New code can run before its migration

- **What happened:** The routing PR reads and writes new columns on `messages`. A merge to `main` makes the Supabase GitHub integration apply the migration (on 2026-10-19, `supabase migration list` showed it about 30 seconds after the merge). Workers Builds deploys the code from the same merge. If the code wins the race, every query that names the new columns fails with `42703 column ... does not exist`, and chat and history return 500. The first test for this case used made-up rows, so it passed anyway.
- **Fix:** For a missing route column error only, the repository repeats the read or insert with the old columns and returns `route: null`. The error must be 42703 or PGRST204, name the `messages` table, and name one of the four route columns exactly. A second review found that the first matcher also accepted other tables, so it was made narrower. A failed insert writes no row, so the repeat cannot make a duplicate.
- **Rule:** Every migration must be additive and safe for the code that is live now. New code must work on the old schema until the migration lands. Match schema errors narrowly. Test against the old and new schemas parsed from the migration files.
- **Sources:** [PR #3 review, round 1](https://github.com/PATELOM925/P-Dot/pull/3#issuecomment-6257890039), [round 2](https://github.com/PATELOM925/P-Dot/pull/3#issuecomment-6258000501) and [fix](https://github.com/PATELOM925/P-Dot/pull/3#issuecomment-6258019314); [Supabase GitHub integration](https://supabase.com/docs/guides/deployment/branching/github-integration); [PostgreSQL error codes](https://www.postgresql.org/docs/current/errcodes-appendix.html); [PostgREST errors](https://docs.postgrest.org/en/stable/references/errors.html).

### 7. Settling after a disconnect depends on `waitUntil`

- **What happened:** When the user presses Stop or disconnects, the settle runs in `waitUntil`. A reviewer proved that the code reaches the OpenNext context and registers the settle promise. A real disconnect in the deployed Worker is not tested yet.
- **Rule:** A settle that never runs must leave the full hold counted. That is the safe side. Do not change this to "refund on doubt".
- **Sources:** [PR #2 review, round 2](https://github.com/PATELOM925/P-Dot/pull/2#issuecomment-6257656084); [Cloudflare Workers context and `waitUntil`](https://developers.cloudflare.com/workers/runtime-apis/context/).

### 8. The circuit breaker is best effort

- **What happened:** A model that fails 3 times in a row is skipped for 30 seconds. The count lives in the memory of one Worker isolate. Cloudflare can start, stop or run many isolates at any time.
- **Rule:** Use the breaker only to save time. Never use process memory for budgets, limits or anything that must be correct.
- **Sources:** [Circuit breaker (Martin Fowler)](https://martinfowler.com/bliki/CircuitBreaker.html); [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/).

### 9. The build copies `.env` files into the Worker

- **What happened:** The OpenNext build copies every value from `.env`, `.env.local` and similar files into the uploaded Worker code, including the `development` values. A provider key in `.env.local` would ship inside the bundle on a manual deploy.
- **Fix:** `npm run deploy` runs `scripts/check-worker-env.mjs` after the build and stops when a name outside the allow list has a value. Production builds run in Workers Builds, where no `.env` file exists.
- **Rule:** Production keys are Worker secrets (`npx wrangler secret put NAME`). Never put a key in `wrangler.jsonc`, a build variable or a `NEXT_PUBLIC_` name.
- **Sources:** [PR #1](https://github.com/PATELOM925/P-Dot/pull/1); [DEPLOYMENT.md](DEPLOYMENT.md).

### 10. Any signed-in user can call the budget functions

- **What happened:** The reserve and settle functions run as the signed-in user, through the public key. A user can call reserve directly and use up shared budget without a real model call. This can stop chat for everyone for the day. It cannot create a charge.
- **Limit in place:** at most $0.50 of Nebius budget and 20 Tavily credits for each user each day, at the SQL level. A user cannot settle another user's hold, settle twice, or raise a hold.
- **If it happens:** turn email confirmation back on or add a CAPTCHA, delete the accounts, then reset the counters.
- **Sources:** [decision 0006](decisions/0006-global-spend-guard.md); [PR #2 review, round 1](https://github.com/PATELOM925/P-Dot/pull/2#issuecomment-6257586511).

### 11. A hold was reduced to fit the ceiling

- **What happened:** One Nebius hold can be at most $0.25. The chat hold used `Math.min(cost, ceiling)`, so a call above $0.25 would hold less than it could cost. The embedder copied this clamp in PR #6 (0dce68a). Two earlier defects had the same effect (lessons 2 and 3).
- **Fix:** `src/server/assistant/spend.ts` is the one owner of the worst-case hold. Above the ceiling it throws `NebiusHoldTooLargeError` before any reserve call. Chat answers 413 and the documents route answers 413. `tests/unit/spend-hold-owner.test.ts` fails when another file uses the ceiling or `costMicroUsd`.
- **Rule:** Never reduce a required hold. If the hold is too large, refuse the call. Compute holds only through the owner functions.
- **Numbers (2026-10-20):** the largest valid chat turn (41 messages of 3-byte characters, search on, Ultra, 8,192 output tokens) holds 138,188 micro-dollars. A test keeps it under 150,000.
- **Sources:** PR #2 commit 1945dda and fix eab3260; PR #6 commit 0dce68a; PR #13.

## Checklists

**Add or change a model**
- Add its price from the [catalog](https://tokenfactory.nebius.com/api/public/models_info) to `pricing.ts`.
- Add it to a tier chain in `tiers.ts`. Config refuses chains with unpriced models.
- Check whether it reasons by default and how it accepts `enable_thinking` and `thinking_token_budget`. Use at most 5 short real calls.
- Run the router and executor tests.

**Add or change an error rule**
- Add a raw fixture (SSE event or HTTP body) to `tests/unit/executor-nebius.test.ts`.
- State whether you saw this shape from the live provider or only assumed it.

**Add a migration**
- Additive only. The live code must keep working after it runs.
- If new code reads new columns, make it tolerant of the old schema, or ship the migration in an earlier merge than the code.
- Remember that the merge applies the migration. No one applies it by hand.

**Change timeouts, retries or hedging**
- Keep the overall deadline and the attempt cap. Every retry and hedge must reserve budget.
- Prove the change with fake timers. Then run a small real latency check and record p50 and max first-token time in the pull request.

## Not verified yet

- Real Nebius error shapes for quota, rate limit and model-not-found inside a stream.
- A real disconnect in the deployed Worker and the `waitUntil` settle.
- Many requests at the same time against the live database.
- The chat screen with routing labels, in a real browser.

## References

- Nebius Token Factory: [docs](https://docs.tokenfactory.nebius.com/), [API reference](https://api.tokenfactory.nebius.com/docs), [public model catalog with prices](https://tokenfactory.nebius.com/api/public/models_info)
- Tavily: [credits and pricing](https://docs.tavily.com/documentation/api-credits)
- [OpenAI-compatible chat API](https://platform.openai.com/docs/api-reference/chat/create) and [error codes](https://platform.openai.com/docs/guides/error-codes)
- [RFC 9110: Retry-After](https://www.rfc-editor.org/rfc/rfc9110#field.retry-after)
- [AWS: Exponential backoff and jitter](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/)
- [Dean and Barroso: The Tail at Scale](https://research.google/pubs/the-tail-at-scale/)
- [Martin Fowler: Circuit breaker](https://martinfowler.com/bliki/CircuitBreaker.html)
- Cloudflare: [Workers context and waitUntil](https://developers.cloudflare.com/workers/runtime-apis/context/), [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- Supabase: [GitHub integration](https://supabase.com/docs/guides/deployment/branching/github-integration), [Auth email (SMTP) limits](https://supabase.com/docs/guides/auth/auth-smtp)
- [PostgreSQL error codes](https://www.postgresql.org/docs/current/errcodes-appendix.html), [PostgREST errors](https://docs.postgrest.org/en/stable/references/errors.html)
- Reviews: PR #2 [round 1](https://github.com/PATELOM925/P-Dot/pull/2#issuecomment-6257586511), [round 2](https://github.com/PATELOM925/P-Dot/pull/2#issuecomment-6257656084); PR #3 [round 1](https://github.com/PATELOM925/P-Dot/pull/3#issuecomment-6257890039), [round 2](https://github.com/PATELOM925/P-Dot/pull/3#issuecomment-6258000501)
