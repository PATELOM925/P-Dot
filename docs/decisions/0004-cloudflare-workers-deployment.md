# 0004 — Deploy to Cloudflare Workers with OpenNext

- Status: Accepted (user decision, 2026-10-15)
- Supersedes: the Vercel hosting assumption in the PRD and architecture

## Decision

Host the Next.js app as a single Cloudflare Worker using `@opennextjs/cloudflare` (pinned 1.20.11) and Wrangler. Configuration lives in `wrangler.jsonc` and `open-next.config.ts`. Vercel-specific code was removed (`maxDuration` export, `VERCEL_URL` fallback, `.vercel/` ignore).

## Details

- Worker runs with `nodejs_compat` and `global_fetch_strictly_public`. No bindings, R2, or KV are used; all routes are dynamic.
- `NEXT_PUBLIC_*` values are inlined at build time. Secrets (`NEBIUS_API_KEY`, `TAVILY_API_KEY`) are Worker secrets; other settings are Worker variables.
- `SITE_URL` must be set in production (there is no platform-provided URL fallback).
- No per-route time limit: the Nebius (55 s total / 25 s idle) and Tavily (10 s) timeouts bound each request.

## Consequences and risks

- **Next.js is pinned to 16.3.8.** With 16.4.1 the Worker returned 500 on every page (`Unexpected loadManifest(/.next/server/preview-props.json)`), because OpenNext 1.20.11 does not inline that manifest. Re-test before upgrading either package.
- **`proxy.ts` uses Node.js middleware, which OpenNext supports only experimentally.** It worked in local Workers-runtime tests. If it proves unreliable, options are moving session refresh into the page/route layer or reverting to an edge `middleware.ts`.
- Native Windows builds are unsupported by OpenNext; deploy from Linux/macOS/WSL or Cloudflare's build service.
- Verified locally only: OpenNext build and a local Workers-runtime preview (health, 401/403 API responses, signed-out redirects, security headers). Not verified: a real Cloudflare deployment, signed-in flows in the Workers runtime, or streaming chat there.
