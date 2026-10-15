# 0002 — Stream assistant replies as NDJSON

- Status: Accepted (user decision, 2026-10-14)
- Supersedes: the "streaming versus complete-response delivery" open decision in the PRD

## Decision

`POST /api/chat` streams the reply to the browser as newline-delimited JSON events (`start`, `search`, `delta`, `done`, `error`; see `ChatStreamEvent` in `src/types/api.ts`). Nebius is called with `stream: true` (server-sent events) and its chunks are relayed as `delta` events.

## Details

- Everything that can be rejected with a proper HTTP status happens **before** the stream starts: origin check, session, body size/shape, configuration, conversation ownership, retry precondition, usage quota, and saving the user's message. After the stream starts, failures arrive as a final `error` event.
- Only **completed** assistant replies are stored. A failed, interrupted, or cancelled reply is not saved; the conversation then ends with an unanswered user message and the UI offers "Retry reply" (`{ action: "retry" }`), which regenerates without duplicating the user message.
- If the browser disconnects or the user presses Stop, the request signal aborts the upstream Nebius call to avoid paying for unused output.
- Timeouts: Nebius 55 s total and 25 s idle between chunks; Tavily 10 s. On Cloudflare there is no per-route `maxDuration`; these timeouts bound the request.

## Consequences

- Better perceived latency; slightly more client code than a single JSON response.
- NDJSON over `fetch` was chosen over `EventSource` because the request is a POST with a JSON body.
