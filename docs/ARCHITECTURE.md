# Proposed architecture

Status: Planned; no runtime or packages initialized.

## System boundaries

```text
Browser: Next.js pages and UI
   |
   | authenticated same-origin requests
   v
Vercel: Next.js API routes
   |-- authentication and ownership checks
   |-- assistant orchestration
   |     |-- Nebius Token Factory: model inference
   |     `-- Tavily: optional web retrieval
   `-- persistence adapter: provider to be selected
```

Use a single Next.js application initially. Its API routes form the backend deployed to Vercel; a separate always-on API server is not planned. The authentication/session mechanism must be selected before private routes are implemented.

## Intended directory structure

```text
src/
  app/
    (auth)/
      login/
      signup/
      forgot-password/
      reset-password/
    (workspace)/
      chat/
      settings/
    api/
      chat/
      conversations/
      health/
  components/
    ui/
    layout/
  features/
    auth/
    chat/
    settings/
  server/
    auth/
    assistant/
    providers/
      nebius/
      tavily/
    db/
  lib/
  types/
public/
tests/
  unit/
  integration/
  e2e/
docs/
  decisions/
```

Parenthesized folders are planned Next.js route groups and will not appear in URLs. Directories contain only `.gitkeep` placeholders until implementation. The landing page and root layout will eventually live directly under `src/app/`.

## Responsibilities

- API routes: Validate requests, verify identity, invoke application services, and translate errors into public responses.
- Assistant service: Assemble bounded conversation context, optionally retrieve search results, call inference, and associate source references with the response.
- Provider adapters: Isolate provider-specific authentication, request/response mapping, and timeouts. Mark these modules server-only when implemented.
- Database adapter: Persist private records and apply ownership checks. Do not use Vercel local files or process memory for durable storage.
- Feature folders: Group product-specific presentation and client state. Shared UI primitives belong in `components/ui/`.

## Proposed data entities

- User: Identity managed by the chosen authentication provider.
- Conversation: ID, owner ID, title, creation time, update time.
- Message: ID, conversation ID, role, content, creation time, completion status, optional source references.
- Usage record: User ID, time window, request count, and bounded cost/token metadata needed for enforcement.

These are conceptual entities, not an approved database schema. Every conversation/message operation must verify ownership on the server.

## Provider contracts

Nebius exposes an OpenAI-compatible API. Configure the base URL and model ID rather than coupling product code to one model. Tavily accepts a search query and returns result metadata and excerpts. Validate provider responses, bound context size, and use timeouts; do not pass arbitrary retrieved instructions into privileged operations.

Reference documentation:

- [Next.js installation and App Router](https://nextjs.org/docs/app/getting-started/installation)
- [Vercel Next.js hosting](https://vercel.com/docs/frameworks/full-stack/nextjs)
- [Nebius API reference](https://api.tokenfactory.nebius.com/docs)
- [Tavily search API](https://docs.tavily.com/documentation/api-reference/endpoint/search)

Recheck current provider documentation and dependency versions when implementation begins.

## Deployment plan

Connect the repository to Vercel after the framework is initialized. Keep preview and production credentials separate. Store secrets in Vercel environment settings; configure authentication redirect URLs for each intended environment. Model inference runs on Nebius infrastructure, while Tavily supplies retrieval.

There is intentionally no `vercel.json`, package manifest, lockfile, CI workflow, or deployment in this planning scaffold. Add configuration only when the implementation requires it.
