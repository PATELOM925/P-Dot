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
- The `workers.dev` address for production is off (`workers_dev: false`). Production is served only on the custom domain.

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
| `NEBIUS_MODEL`, `NEBIUS_BASE_URL`, `NEBIUS_MAX_OUTPUT_TOKENS`, `CHAT_REQUESTS_PER_WINDOW`, `CHAT_WINDOW_SECONDS` | Runtime variables | Dashboard: Workers & Pages → `pdot` → Settings → Variables and Secrets. `keep_vars: true` in `wrangler.jsonc` keeps them when a deploy runs. |
| `NEBIUS_API_KEY`, `TAVILY_API_KEY` | Runtime secrets | `npx wrangler secret put NAME` (owner only) |

Rules:

- Never commit a secret. Never put a secret in `wrangler.jsonc`, in a build variable, or in a `NEXT_PUBLIC_` variable.
- Never add the Supabase secret key (service role key), a database password or a connection string to the Worker.
- **The OpenNext build copies every value from `.env`, `.env.local` and `.env.production` into the Worker bundle** (`.open-next/cloudflare/next-env.mjs`). `npm run deploy` and `npm run upload` run `scripts/check-worker-env.mjs` after the build. It stops the deploy if a secret-like variable (for example `NEBIUS_API_KEY`) has a value in that file. Workers Builds has no `.env` file, so this problem does not occur there.
- Previews use their own secrets (`npx wrangler preview secret`) and the preview base config in the dashboard. Until the owner adds preview secrets, chat in a preview says "This service is not configured yet."

## Previews: what to know

- A preview link works like the live site, but it is a different address on `workers.dev`.
- A preview uses the **production Supabase database**. If you sign up or chat in a preview, the data is real. Use a test account. Never run a migration from a branch.
- Email links (confirm sign-up, reset password) always go to `SITE_URL`, which is the production address.
- `wrangler preview` is in open beta. Check that the first pull request after setup gets a working preview link. If it does not, record what happened in this file.
- To test the Workers runtime without Cloudflare access, run `npm run preview` on your computer. It uses your `.env.local` and your local or hosted Supabase. Stop `npm run dev` first.

## Database changes

Migrations are in `supabase/migrations/`. Neither a merge nor a deploy applies them. The owner applies each migration to the hosted project by hand (`supabase db push` from a linked checkout, or the SQL editor), **before** the code that needs it is merged. Write each migration so that the code which is live now still works after it runs.

## One-time setup (owner only)

These steps need the owner's Cloudflare or Supabase account. They are not done yet unless this list says so.

1. **Connect Workers Builds.** Dashboard → Workers & Pages → `pdot` → Settings → Build → Connect. Choose GitHub, install the Cloudflare app on `PATELOM925/P-Dot` only, then enter the values from [What runs in Workers Builds](#what-runs-in-workers-builds). The Free plan includes 3,000 build minutes each month.
2. **Set provider secrets** when the Nebius and Tavily accounts exist:

   ```bash
   npx wrangler secret put NEBIUS_API_KEY
   npx wrangler secret put TAVILY_API_KEY
   ```

   Then set `NEBIUS_MODEL` as a variable in the dashboard. Set a spending limit on both provider accounts first.
3. **Supabase Auth URL configuration** (Authentication → URL Configuration): Site URL `https://pdot.iampatelom.com`; redirect URLs `https://pdot.iampatelom.com/**` and `http://localhost:3000/**`. Use the email templates from the README "Setup" section.
4. **Email sending.** The default Supabase email service sends only to members of the Supabase organization's team, and about 2 messages each hour. Before other people sign up, either add them to the Supabase team, create their accounts in the dashboard (Authentication → Users → Add user, "Auto Confirm User"), or set up custom SMTP.

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
- The Worker must stay under 3 MiB compressed on the Workers Free plan. The first deploy (2026-10-19) was 2,344 KiB compressed (11,728 KiB before compression).
- Logs: `npx wrangler tail pdot --format json` (owner account). Preview versions do not appear in `wrangler tail`.
