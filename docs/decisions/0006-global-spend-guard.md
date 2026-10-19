# 0006: Global spend guard for paid providers

- Status: Accepted (2026-10-19).
- Code: `supabase/migrations/20261019000000_global_spend_guard.sql`, `src/server/db/spend.ts`, `src/server/assistant/spend.ts`, `src/server/providers/nebius/pricing.ts`.

## Problem

Sign-up is open. The only old limit was per user: 30 chat requests each hour. A person can make many accounts and use the owner's paid credit:

- Nebius Token Factory: a $25 credit, then charges to the owner's card. This is the main risk.
- Tavily: a free plan with 1,000 credits each month. Pay-as-you-go is off, so it stops and does not charge. The credits must last through the demo and judging.

## Decision

All users together share caps on paid calls. The caps are in Postgres, so they work across all Worker instances.

| Provider | Cap | Default | Setting |
| --- | --- | --- | --- |
| Nebius | All users, each UTC day | $1.00 | `NEBIUS_DAILY_CAP_USD` |
| Nebius | All users, all time | $20.00 (keeps $5 of the $25 credit) | `NEBIUS_TOTAL_CAP_USD` |
| Nebius | One user, each UTC day | $0.25 (at most $0.50) | `NEBIUS_USER_DAILY_CAP_USD` |
| Tavily | All users, each UTC day | 40 credits | `TAVILY_DAILY_CREDITS` |
| Tavily | All users, each UTC calendar month | 800 credits | `TAVILY_MONTHLY_CREDITS` |
| Tavily | One user, each UTC day | 10 credits (at most 20) | `TAVILY_USER_DAILY_CREDITS` |

All Nebius models count together. Only models with a price in the table can be used. A basic Tavily search costs 1 credit. The app uses only basic search.

### How a request is counted

1. The per-user quota (`consume_chat_quota`) runs first.
2. **Hold.** The server calls `reserve_provider_spend` with a worst-case cost. For Nebius, this is every UTF-8 byte of the prompt as one input token (a tokenizer never makes more tokens than bytes), plus space for search results when search is on, plus `NEBIUS_MAX_OUTPUT_TOKENS` output tokens. The price comes from the table in `pricing.ts`. A model that is not in the table cannot be used: there is no fallback price, because some Nebius models (for example `moonshotai/Kimi-K3` at $3 / $15 per million tokens) cost more than every model in the table. Chat then returns "This service is not configured yet." before any database or provider call. The function adds the hold to the counters only if no cap would be passed. Row locks make this safe when requests arrive at the same time.
3. If a Nebius cap refuses, the API returns `budget_exhausted` before it streams: HTTP 429 with `Retry-After` for a daily cap, HTTP 503 for the total cap. Nothing is saved and no provider is called.
4. If only the Tavily cap refuses, the reply is still made without search. The user sees "Web search was not used because P-Dot has reached its search limit for now…", and the model is told that search failed, so it does not claim web sources.
5. **Settle.** When the stream ends, the server calls `settle_provider_spend` with the real cost from the `usage` chunk (`stream_options.include_usage`). The difference goes back to the counters. If usage does not arrive (provider error, Stop, disconnect, reply cut at the character limit), the full hold stays counted. The settle runs in `waitUntil`, so a disconnect does not cancel it. Tavily holds are not given back: a search that was sent counts.

A settle that never happens leaves the full hold counted. That is the safe side.

### Reasoning

Nemotron models reason by default. The reasoning arrives in the `reasoning` and `reasoning_content` fields, is billed as output tokens, and counts against `max_tokens`. With a small limit, a reply can be empty. The client sends `chat_template_kwargs: { enable_thinking: false }`, which gave 0 reasoning tokens on Nano, Lightning, Super and Ultra in real calls on 2026-10-19. The client ignores reasoning fields and removes a leading `<think>…</think>` block from the reply text, so reasoning is never shown or saved.

## Trust and the denial-of-service limit

The app has no service-role key, so the server calls these functions with the user's session. Any signed-in user can call them directly with the public key and choose the parameters. The design limits what that can do:

- Users cannot read or write the two tables (RLS on, no policies, no grants).
- Every parameter has hard bounds in SQL: one Nebius hold is at most $0.25, the per-user daily cap at most $0.50, and so on.
- Settle can only give back. It works once, only for the caller's own reservation, and only between 0 and that reservation's hold.
- The server's reservation IDs (random UUIDs) never leave the Worker, and users cannot read the table. So a user cannot give back the server's holds. A user can give back only holds they made themselves, which leaves the totals where they started.

**Known limit (denial of service).** A user can call `reserve_provider_spend` directly and never settle, which uses up budget without a provider call. Then the app refuses chat for everyone until the next day (daily cap) or until the owner acts (total cap). A hard per-user ceiling in SQL limits one account to $0.50 of Nebius budget and 20 Tavily credits each UTC day, and to 1,000 reservations for each provider each day. Many accounts can still use up the caps. This causes an outage, not a charge: the owner's money stays safe. If it happens, the owner can turn on email confirmation or CAPTCHA in Supabase Auth, delete the accounts, and reset the counters.

## How to change the caps

- Change the values in `wrangler.jsonc`, in **both** `vars` and `previews.vars`, through a pull request. The server checks the bounds on each request. A value out of bounds makes chat say "This service is not configured yet."
- A cap applies from the next request. Lowering a cap below what is already used refuses new requests until the period ends.
- Per-user caps above the all-users daily cap are lowered to it.
- To see or reset usage (owner only, Supabase SQL editor):

  ```sql
  select * from public.spend_counters order by period_start desc;
  -- Start the all-time Nebius count again, for example after adding credit:
  update public.spend_counters set used = 0 where provider = 'nebius' and period_kind = 'total';
  ```

## What this does not do

- It does not read the real balance from Nebius or Tavily. The counters are an estimate from the price table. Check the provider dashboards too, and set provider-side limits where they exist.
- The price table must be updated when Nebius changes prices. To use a new model, add its price first.
- Token counts in the usage chunk must be non-negative whole numbers. Other values count as missing usage, so the full hold stays counted.
- No admin page. Changes go through config or SQL.

## Real checks (2026-10-19)

- Model `nvidia/nemotron-3-super-120b-a12b`, reasoning on (the default): 37 input and 45 output tokens, 31 of them reasoning. Reasoning came in `reasoning` and `reasoning_content`. Usage came in a last chunk with an empty `choices` list.
- Same prompt with `enable_thinking: false`: 37 input and 11 output tokens, 0 reasoning.
- Through the app's own client: 36 input and 254 output tokens. The hold was 323 micro-dollars and the settle was 240 micro-dollars ($0.00024).
- Tavily usage endpoint: 9 of 1,000 credits used on the Researcher (free) plan.
