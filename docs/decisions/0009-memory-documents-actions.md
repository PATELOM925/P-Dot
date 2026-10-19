# 0009 — Memory, documents, action proposals, the action log, reminders and "what was sent"

- Status: Accepted for build (owner, 2026-10-19). Shapes may change during review.
- Related: [0006 spend guard](0006-global-spend-guard.md), [0007 model routing](0007-model-routing.md), [PROVIDER-RELIABILITY.md](../PROVIDER-RELIABILITY.md).

## Why

The pitch is a private assistant that remembers what you let it, shows what it sent to the model, and does nothing without your approval. This decision adds the storage and APIs for that. The AI logic that uses them (when to save a memory, how to retrieve, the tool loop) belongs to the AI layer and calls these modules.

## Storage

Migration `supabase/migrations/20261020000000_memory_documents_actions.sql`. Every table has `user_id = auth.uid()` with RLS, no access for `anon`, and column-level update grants.

| Table | Purpose | Notes |
| --- | --- | --- |
| `memories` | Facts the user can see, edit and delete | `status`: `proposed` (from the assistant, waiting) or `active` (used in replies). `source`: `user` or `assistant`. `embedding vector(1024)`. Optional link to the source message (same user only; deleting the message keeps the memory). |
| `documents` | Uploaded plain text or Markdown | `status`: `processing`, `ready`, `failed`. Up to 100,000 characters. |
| `document_chunks` | Searchable parts of a document | About 2,000 characters with 200 overlap. Deleted with the document. |
| `action_proposals` | Actions the assistant proposes | `kind`: `create_task`, `create_reminder`, `save_memory`. Inserted only as `proposed`. Cannot be deleted by the user (audit). |
| `action_log` | Append-only record of what happened | No update or delete. IDs, kinds and counts only, never message or memory text. |
| `reminders` | Reminders with a due time | Delivery (scheduled jobs, notifications) is a later change. |
| `context_records` | "What was sent" for each assistant reply | Model, history size, memory IDs, document chunk IDs, web source count, prompt version, token counts. No copied text. |

Similarity search: `match_memories(query, mode, count)` and `match_document_chunks(query, mode, count)`. Both are `SECURITY INVOKER`, so RLS applies, and both cap the count at 20.

Tested on 2026-10-19 on an in-memory Postgres 17 with pgvector (all migrations in order): users cannot read, change, link to or search another user's rows; `anon` has no access; proposals cannot be inserted as executed or deleted; the log cannot be changed or deleted; search returns only the caller's rows and at most 20.

## Embeddings

- Model `Qwen/Qwen3-Embedding-8B` on Nebius Token Factory with `dimensions: 1024` (checked on 2026-10-19: 1,024 numbers, length 1). It costs $0.01 per million tokens.
- `src/server/providers/nebius/embeddings.ts` calls the API. `src/server/assistant/embed.ts` wraps it with the spend guard: each batch of up to 32 texts reserves its worst case first and settles the real cost after. Invalid or missing usage keeps the full hold.
- `src/server/db/retrieval.ts` runs the similarity search.

## API (shapes for the frontend and the AI layer)

All routes need a session. Write routes need a same-origin request. Errors use the usual `{ error: { code, message, requestId } }`. Types are in `src/types/api.ts` and request schemas in `src/lib/schemas.ts`.

| Method and path | Body | Result |
| --- | --- | --- |
| `GET /api/memories?mode=&status=` | | `{ memories: MemoryDTO[] }` |
| `POST /api/memories` | `{ mode, content }` | `MemoryDTO`, 201. Embeds the text. |
| `PATCH /api/memories/:id` | `{ content?, mode?, status?: "active" }` | `MemoryDTO`. Re-embeds when the text changes. |
| `DELETE /api/memories/:id` | | 204 |
| `GET /api/documents?mode=` | | `{ documents: DocumentDTO[] }` |
| `POST /api/documents` | `{ mode, title, mediaType, text }` | `DocumentDTO`, 201. Chunks and embeds the text. |
| `DELETE /api/documents/:id` | | 204 |
| `GET /api/actions?status=` | | `{ actions: ActionProposalDTO[] }` |
| `POST /api/actions/:id/decision` | `{ decision: "approve" \| "reject", payload? }` | `ActionProposalDTO` after it runs |
| `GET /api/action-log` | | `{ entries: ActionLogEntryDTO[] }` |
| `GET /api/reminders?mode=` | | `{ reminders: ReminderDTO[] }` |
| `POST /api/reminders` | `{ mode, title, dueAt }` | `ReminderDTO`, 201 |
| `PATCH /api/reminders/:id` | `{ title?, dueAt?, status? }` | `ReminderDTO` |
| `DELETE /api/reminders/:id` | | 204 |
| `GET /api/messages/:id/context` | | `ContextRecordDTO` |

Every change through these routes also writes one `action_log` row.

## Rules

- **Approval first.** The AI layer creates `action_proposals` only. An action runs only after `POST /api/actions/:id/decision` with `approve`. The kinds today change only P-Dot's own data. A kind that changes an outside account (email, calendar, devices) needs its own decision.
- **The user edits before approving.** The decision can carry an edited payload of the same kind, checked with `actionPayloadSchema`.
- **Memory from the assistant starts as `proposed`.** It is not used in replies until the user approves it.
- **Retrieved text is untrusted.** Memories and document chunks go into the prompt inside delimiters, like web results, and cannot authorize actions.
- **Privacy.** The log and context records hold IDs and counts, not text. Deleting a memory or a document removes its text and vector at once.
- **Cost.** Every embedding goes through the spend guard. A document upload is limited to 100,000 characters (under $0.001 to embed).

## Not in this change

Scheduled reminder delivery and push notifications, the tool loop that creates proposals, using memories and documents in the chat prompt, and the frontend screens. They build on these shapes.

## Frontend (2026-10-19)

The screens now use these routes: approval cards in chat and on Today (approve, edit then approve, cancel), the Memory page (memories and documents: add, keep, edit, move, delete), "What was sent" under each reply, the action log page, reminders on Workflows, and live counts on Connectors. The pages say plainly that replies do not use memories or documents yet and that the assistant does not propose actions yet. The server saves a reply's context record just after it sends `done`, so "What was sent" offers "Check again" for a reply under a minute old instead of treating a 404 as final. Push delivery and device pairing are in [0010](0010-pwa-and-device-pairing.md).

In chat, each suggestion appears under the reply of the turn it came from: action proposals waiting for approval as cards, earlier decisions as short lines, and memories P-Dot suggested as "Remember this?" cards (Keep, Edit then keep, Don't keep). The Today tab shows how many proposals are waiting, in both modes.

### What the screens expect from the AI layer

Checked with proposals and memories inserted directly into a local database, since nothing creates them yet.

- **Proposals.** Set `conversation_id`, and create the proposal while handling the turn (after its user message is saved). Chat places a proposal under the reply of the last user message saved before it, using the database times. Save it before sending `done`: the chat reloads proposals, and the Today count, when `done` arrives, and not again until the next reply or conversation switch. Write the summary as one plain sentence; the card shows it as P-Dot's words and lists the details from the payload, which is what runs. A `message_id` column on proposals would make the placement exact instead of time-based.
- **Suggested memories.** Use `status: "proposed"`, `source: "assistant"` and `source_message_id` set to the reply (or the user message) the fact came from. Chat shows them under that turn's reply; the Memory page lists them under "Suggested by P-Dot". Keep means `PATCH` to `active`, Edit then keep sends the new text and `active` together, Don't keep deletes the row. Save them before `done`, like proposals. A `save_memory` proposal also works; it appears as an approval card instead.
- **Memories used in a reply.** Put the IDs actually sent in the context record (`memoryIds`, `documentChunkIds`; `service.ts` passes empty lists today). "What was sent" shows their current text. A small count on `MessageDTO` (memories and documents used) would let a reply show "Used 2 memories" without opening the panel; the screens do not depend on it.
- **Approval modes.** Ask first and Auto, the rule for which kinds may run on their own, and the server-side steps are in [0011](0011-approval-modes.md).
- **Copy to update when this lands:** the notice on the Memory page, the Built in note and the Documents card on Connectors, the Memory and Documents lines in Settings → How your data is used, and the note on the landing page. Each says the step is not built yet.
