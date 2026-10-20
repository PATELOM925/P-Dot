# Deployment guide

This guide tells people and coding agents how P-Dot goes from a branch to the live site. Read it before you change `wrangler.jsonc`, `open-next.config.ts`, `package.json` scripts, environment variables or anything in this file.

## Summary

| Where | Address | How it updates |
| --- | --- | --- |
| Production | https://pdot.iampatelom.com | A merge to `main` deploys it (after the owner connects Workers Builds, see [One-time setup](#one-time-setup-owner-only)) |
| Pull request preview | A `*.workers.dev` link that Cloudflare posts on the pull request | Each push to a pull request branch |
| Your computer, Node.js | http://localhost:3000 | `npm run dev` |
| Your computer, Workers runtime | The address that `npm run preview` prints | `npm run preview` |

- Hosting: one Cloudflare Worker named `pdot`, built with the OpenNext adapter. Decision: [0004](decisions/0004-cloudflare-workers-deployment.md).
- Database and accounts: one hosted Supabase project. Production and previews use the **same** database.
- The `workers.dev` address for production is off (`workers_dev: false`). Production is served only on the custom domain. `preview_urls: true` turns on `workers.dev` links for Previews and for each uploaded version.

## The normal flow

1. Make a branch from `main`. Do the work. Run `npm run check` and `npm run build`. Both must pass.
2. Push the branch and open a pull request into `main`.
3. Cloudflare Workers Builds builds the branch and posts a comment on the pull request with the build result and a preview link.
4. An adversarial review is posted on the pull request as comments. Fix or answer each comment before merge.
5. The owner (Om) merges. Do not merge your own pull request.
6. Workers Builds builds `main` and deploys it to https://pdot.iampatelom.com. Check the result:

   ```bash
   curl -sS https://pdot.iampatelom.com/api/health
   ```

   Expected: `{"status":"ok","configured":{"auth":true,...}}`. The health check shows which settings exist. It does not call Nebius or Tavily.

Until the owner connects Workers Builds, a merge to `main` does **not** deploy. Only the owner can deploy, with `npm run deploy` from a computer that is logged in to Cloudflare.

## What runs in Workers Builds

These are the settings in the Cloudflare dashboard (Workers & Pages → `pdot` → Settings → Build). They are not stored in Git, so keep this table the same as the dashboard.

| Setting | Value |
| --- | --- |
| Git repository | `PATELOM925/P-Dot` |
| Production branch | `main` |
| Build command | `npm run check && npx opennextjs-cloudflare build && npm run check:worker-env` |
| Deploy command | `npx opennextjs-cloudflare deploy` |
| Builds for non-production branches | On |
| Non-production branch command | `npx wrangler preview` (the default) |
| Build variables | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (hosted project values; both are public by design) |
| Node.js version | From `.nvmrc` (22) |

If `npm run check` fails, the build stops and nothing is deployed.

## Settings and secrets

| Name | Kind | Where it is set |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Build time. Put into the browser bundle. Public. | Workers Builds build variables, or `.env.local` for a manual deploy |
| `SITE_URL` | Runtime variable | `wrangler.jsonc` (`https://pdot.iampatelom.com`) |
| `NEBIUS_BASE_URL`, `CHAT_REQUESTS_PER_WINDOW`, `CHAT_WINDOW_SECONDS`; the model routing settings `NEBIUS_FAST_MODELS`, `NEBIUS_STANDARD_MODELS`, `NEBIUS_HEAVY_MODELS`, `NEBIUS_VISION_MODELS`, `NEBIUS_MAX_OUTPUT_TOKENS`, `NEBIUS_STANDARD_MAX_OUTPUT_TOKENS`, `NEBIUS_HEAVY_MAX_OUTPUT_TOKENS`, `NEBIUS_HEAVY_THINKING_BUDGET`, `NEBIUS_HEDGE_AFTER_MS` ([decision 0007](decisions/0007-model-routing.md)); and the spend caps `NEBIUS_DAILY_CAP_USD`, `NEBIUS_TOTAL_CAP_USD`, `NEBIUS_USER_DAILY_CAP_USD`, `TAVILY_DAILY_CREDITS`, `TAVILY_MONTHLY_CREDITS`, `TAVILY_USER_DAILY_CREDITS` ([decision 0006](decisions/0006-global-spend-guard.md)) | Runtime variables. The code has a default for each. `wrangler.jsonc` sets the routing settings (the same values as the defaults) and each cap. `NEBIUS_MODEL` is no longer read. | `wrangler.jsonc`, in **both** `vars` (production) and `previews.vars` (Previews), changed through a pull request. Previews do not get top-level `vars` or dashboard variables. `tests/unit/wrangler-config.test.ts` fails if the two lists have different names. Dashboard variables (Workers & Pages → `pdot` → Settings → Variables and Secrets) are kept on deploy by `keep_vars: true`, but they apply to production only. |
| `NEBIUS_API_KEY`, `TAVILY_API_KEY` | Runtime secrets | `npx wrangler secret put NAME` (owner only) |

Rules:

- Never commit a secret. Never put a secret in `wrangler.jsonc`, in a build variable, or in a `NEXT_PUBLIC_` variable.
- Never add the Supabase secret key (service role key), a database password or a connection string to the Worker.
- **The OpenNext build copies every value from `.env`, `.env.local`, `.env.production` and `.env.production.local` (and the `development` versions) into the Worker bundle** (`.open-next/cloudflare/next-env.mjs`). `npm run deploy` and `npm run upload` run `scripts/check-worker-env.mjs` after the build. It stops the deploy if any variable that is not on its allow list has a value in that file. The allow list is in `scripts/worker-env-rules.mjs`: the two public Supabase values, `SITE_URL`, the Nebius and chat-limit settings, and the spend caps. A unit test fails if a name in `wrangler.jsonc` `vars` is not on it. Keys, passwords and connection strings are never on it. To add a non-secret setting, add its name there through a pull request. Workers Builds has no `.env` file, so this problem does not occur there.
- Previews do not get the production secrets. They use the `previews` block in `wrangler.jsonc` for variables, and the Preview base config for secrets (`npx wrangler preview base-config secret put NAME`, owner only). Until the owner adds them, chat in a preview says "This service is not configured yet."

## Previews: what to know

- Each pull request branch gets a Preview at `<branch>-pdot.<account subdomain>.workers.dev`. Later pushes to the branch update the same link. Cloudflare posts it on the pull request.
- `wrangler preview` needs the `previews` block in `wrangler.jsonc` (it can be empty). Keep it there.
- The `preview_urls: true` setting takes effect at the first production deploy after it is merged. Previews have no link before then.
- A Preview uses the **production Supabase database**. If you sign up or chat in a Preview, the data is real. Use a test account. Never run a migration from a branch.
- Email links (confirm sign-up, reset password) always go to `SITE_URL`, which is the production address.
- Previews do not get the top-level `WORKER_SELF_REFERENCE` service binding, and the `previews` block does not add it. (If it were added there, it would call the production Worker.) OpenNext uses this binding only for cache work, and this app has no cache, so it has no effect today. Do not add a cache without a fix for this.
- Version links (`<version>-pdot.<account subdomain>.workers.dev`) also open each uploaded production version. They need the same sign-in as the live site.
- Workers Previews are in open beta. The Cloudflare documentation does not give a price for them. The owner checks the Workers plan page before turning on branch builds. Check that the first pull request after setup gets a working Preview link. If it does not, record what happened in this file.
- Preview logs do not appear in `wrangler tail`.
- To test the Workers runtime without Cloudflare access, run `npm run preview` on your computer. It uses your `.env.local` and your local or hosted Supabase. Stop `npm run dev` first.

## Database changes

Migrations are in `supabase/migrations/`. The hosted Supabase project has the GitHub integration on: a merge to `main` applies new migrations automatically. Agents never apply migrations. Write each migration so that the code which is live now still works after it runs (additive changes only). The new code and the migration go live at about the same time; for a short time the new code can run before its migration, so new database calls must fail closed.

When a change must also remove something that the live code uses (a grant, a policy, a column), ship it in two steps, expand then contract:

1. **Expand.** A migration that only adds, and the code that uses the addition. The live code must keep working during and after this migration. Merge, and wait until the new code is live.
2. **Contract.** A later migration that removes the old path, in a separate pull request. Merge it only after step 1 is live. Its PR body says which PR is the expand step.

Example: the memory hardening ships as `20261021000000_memory_hardening.sql` (expand, PR #13) and `20261021010000_memory_hardening_contract.sql` (contract, PR #14).

## One-time setup (owner only)

These steps need the owner's Cloudflare or Supabase account. They are not done yet unless this list says so.

1. **Connect Workers Builds.** Dashboard → Workers & Pages → `pdot` → Settings → Build → Connect. Choose GitHub, install the Cloudflare app on `PATELOM925/P-Dot` only, then enter the values from [What runs in Workers Builds](#what-runs-in-workers-builds). The Free plan includes 3,000 build minutes each month.
2. **Set provider secrets** when the Nebius and Tavily accounts exist:

   ```bash
   npx wrangler secret put NEBIUS_API_KEY
   npx wrangler secret put TAVILY_API_KEY
   ```

   Set a spending limit on both provider accounts first.
3. **Models and spend caps.** `wrangler.jsonc` sets the model chain for each tier (`NEBIUS_FAST_MODELS` and the others) and the global spend caps in both `vars` and `previews.vars`. To change one, open a pull request. Every model in a chain must have a price in `src/server/providers/nebius/pricing.ts`. If one does not, chat says "This service is not configured yet." and no provider is called. Add the price in the same pull request. See [decision 0006](decisions/0006-global-spend-guard.md) and [decision 0007](decisions/0007-model-routing.md). If `NEBIUS_MODEL` was set in the dashboard, you can delete it there: the code no longer reads it.
4. **Preview secrets (optional).** To let Previews call Nebius and Tavily, set them in the Preview base config. Use a separate key with a low spending limit if the provider allows it:

   ```bash
   npx wrangler preview base-config secret put NEBIUS_API_KEY
   npx wrangler preview base-config secret put TAVILY_API_KEY
   ```

   Changes to base secrets apply only to Previews created after the change.
5. **Supabase Auth URL configuration** (Authentication → URL Configuration): Site URL `https://pdot.iampatelom.com`; redirect URLs `https://pdot.iampatelom.com/**` and `http://localhost:3000/**`. Use the email templates from the README "Setup" section.
6. **Email sending.** The default Supabase email service sends only to members of the Supabase organization's team, and about 2 messages each hour. Before other people sign up, either add them to the Supabase team, create their accounts in the dashboard (Authentication → Users → Add user, "Auto Confirm User"), or set up custom SMTP.

## Manual deploy (owner only, fallback)

Use this only when Workers Builds is not available. You need macOS, Linux or WSL and `npx wrangler login`.

1. Make sure `.env.local` has the **hosted** Supabase URL and publishable key, and no provider keys (the guard stops the deploy if it finds them).
2. Run `npm run check`, then `npm run deploy`.
3. Check `/api/health`, `/`, `/login` and that `/chat` redirects to `/login` when you are signed out.

`npm run upload` uploads a new version without sending traffic to it.

## Rules for coding agents

- Do not run `npm run deploy`, `npm run upload`, `wrangler deploy`, `wrangler secret put`, `wrangler preview` or any other command that changes Cloudflare, unless the owner asks for it in the current task.
- Do not merge pull requests. Do not push to `main`.
- Do not change DNS, routes, the custom domain, `workers_dev` or `preview_urls` without the owner's approval.
- Do not upgrade the Cloudflare or Supabase plan or turn on a paid feature.
- Keep this file, the README and `.env.example` correct when you change deployment settings.

## Known limits

- Next.js is pinned to 16.3.8 and `@opennextjs/cloudflare` to 1.20.11. Next 16.4.1 broke every page in the Workers runtime. Test a preview before you upgrade either one.
- `src/proxy.ts` uses Node.js middleware, which OpenNext supports only as experimental. Watch the session redirects after each deploy.
- Worker size limit: 64 MiB **uncompressed** on the Free and Paid plans. There is no compressed limit; the gzip number from Wrangler is for reference only. Check the `Total Upload` value from `npx wrangler deploy --dry-run --outdir <folder>`. The first deploy (2026-10-19) was 11,728 KiB uncompressed (2,344 KiB gzip). Source: https://developers.cloudflare.com/workers/platform/limits/#worker-size
- Logs: `npx wrangler tail pdot --format json` (owner account). Preview versions do not appear in `wrangler tail`.
- Model routing: each reply writes one `model_route` log line (tier, reason, models tried, attempts, hedge, `firstTokenMs`, `totalMs`, outcome). Use it to check the time to the first token and how often fallbacks happen. The circuit breaker lives in each isolate's memory only, so different isolates can decide differently for a short time.
- Spend caps: Previews use the production database, so Preview chats count against the same global caps. The `spend_limit_reached` log event shows when a cap refuses a request. Usage is in the `spend_counters` table (SQL editor, owner only).
