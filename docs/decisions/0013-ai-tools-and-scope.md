# 0013: Assistant tools, retrieval and the accepted scope

- Status: Accepted (2026-10-30). Om and Tirth accepted the decision record "AI layer: two paths, one base" of 2026-10-22, and all 10 of its recommended answers.
- Related: [0006 spend guard](0006-global-spend-guard.md), [0007 model routing](0007-model-routing.md), [0009 memory and actions](0009-memory-documents-actions.md), [0011 approval modes](0011-approval-modes.md), [0012 resend idempotency](0012-resend-idempotency.md).
- Code: `src/server/assistant/tools/`, `src/server/assistant/service.ts` (`runChatTurn`), `src/server/providers/nebius/client.ts`, `tests/evals/`.

## Why

Tirth built a tool loop, retrieval tools, an eval suite and hallucination tests on a branch that started before the spend guard. That branch does not merge (`archive/tirth-ai-layer-92281ce`). This record keeps the parts that main takes, with main's rules: every paid call holds spend, every action goes through `action_proposals`, and retrieved text never enters the system prompt.

## The 10 accepted answers

| # | Question | Answer |
| --- | --- | --- |
| 1 | May the model call web search on its own? | Only when the user's search toggle is on. Within a turn, the model picks the query and may search once more within the hop cap. |
| 2 | Show the model's plan text before a tool call? | No. A status line shows the tool name and the query. |
| 3 | Which memories reach the prompt, and where? | Active memories of the current mode, top 4 by match, in the final user turn in an untrusted block. Their IDs go in the context record. |
| 4 | Is `save_memory` a proposed memory or an action proposal? | A proposed memory with `source_message_id`. The "Remember this?" card handles it. |
| 5 | Hop cap and tier for tool turns? | 2 tool hops plus one final pass, standard tier, hedge off. |
| 6 | Output tokens? | Keep 1,024, 2,048 and 4,096 by tier. "Think harder" gives 4,096. |
| 7 | Session summaries now or later? | Later, on the server, as proposed memories only, after a PRD decision. |
| 8 | Embedding width? | Keep 1,024. |
| 9 | PDFs and generated reports in Git? | No PDFs. Markdown reports under `docs/reports/` with a date. Eval output stays untracked. |
| 10 | The PRD excludes memory, documents and actions. What now? | The PRD changes to the accepted scope: approval first, memory the user can see and edit, documents as plain text. |

## Tool protocol

- **Adapter.** The Nebius adapter sends `tools` (OpenAI function format) and `tool_choice: "auto"` only when a tool is offered. It joins `delta.tool_calls` by index into whole calls and sends them once, just before `finish`. A call without a name is dropped. A call with a missing or repeated ID gets a new unique ID (`call_<index>`, then `call_<index>_<n>`), so each tool result answers exactly one call. More than 8 calls, a name above 64 characters or arguments above 16,000 characters make the response malformed (`bad_response`). The first delta of each call is a `tool_progress` marker, so the first-token timeout sees it.
- **Executor.** Whole tool calls are a commit point, like the first visible text: no retry or model switch after them. With tools off, tool calls are not a reply, and the attempt counts as empty.
- **No model switch after visible text, for the whole turn.** After a hop sends visible text, later hops use only the model that wrote it. They can retry that model, but they never fall back to another one; an error then ends the turn with an error event, as a mid-stream error does. Before any visible text, a later hop can use the whole chain.
- **Loop.** `runChatTurn` runs at most 2 tool hops. A hop that returns tool calls runs them and gives the results to the next hop as `tool` messages. The third pass always has tools off, so the turn ends with a reply. At most 3 calls of one response run; later calls get a refusal as their result.
- **Validation.** Each tool has a zod schema. The JSON schema sent to the model is made from it (`z.toJSONSchema`), so the two cannot differ. A call runs only after `JSON.parse` and `safeParse` pass. Otherwise the model gets a refusal that names the bad fields, and nothing runs.
- **Tier.** A turn that offers a tool runs on the standard tier at least, which has no hedge. "Think harder" keeps the heavy tier. The route reason stays the router's, because the `route_reason` column has a fixed list.
- **Spend.** The hold made before the stream prices the first attempt of the first hop with every tool the turn can offer. Every other attempt of every hop reserves its own hold for its real messages and tools, through the same `AttemptBudget`, and settles from usage. A refused hold stops the turn with `budget_exhausted`, and nothing is saved. A hold above the ceiling stops it with `payload_too_large`. The hold counts the tool definitions as their JSON request bytes and every tool call and tool result with its ID. It adds an allowance for the chat template's tool text: 1,024 tokens when tools are offered or earlier tool messages are in the prompt (so the final pass with tools off has it too), plus 128 for each tool definition and 64 for each tool call and each tool result. **This allowance is an estimate, not a measurement.** If real usage is above a hold, the settle counts only the hold, so the allowance is set well above the templates we know.
- **Deadline.** All hops share the tier's deadline, so a turn stays inside the 300-second reply claim lease of decision 0012. `tests/unit/request-key.test.ts` checks the lease against the deadline and two searches.
- **web_search.** Offered only when the user turned search on, search is configured and the search budget allowed the first search. The first search still uses the user's message, as before. The tool can run once in a turn. Each run holds one Tavily credit first. If Stop comes while the credit is held, no search is sent and the credit is settled at 0 under `waitUntil`. Its new results continue the source numbers, and the saved reply keeps all sources.
- **Status event.** `{ type: "status", tool, query? }` before a tool runs. It carries only the tool name and, for a search, the query. It is never saved and never carries the model's text. The prompt asks the model to call a tool without text before the call. Text that a model writes anyway stays in the reply, as the user saw it.
- **Logs.** Tool events log the tool name (or `unknown`) and the hop. Never the query, the arguments or a result.

## Memory, documents and proposals

- **Memories before each turn.** The server embeds the user's message (one budgeted embedding, which holds spend) and takes the top 4 active memories of the conversation's mode (`match_memories`). They go in the final user turn in a `<saved_memories>` block with the same untrusted words as web results, never in the system message. The first hold prices the largest memory block (`MEMORY_BLOCK_MAX_BYTES`). Their IDs go in the context record. If retrieval fails, the reply goes on without memories.
- **`search_documents` and `search_memories`.** Read tools over `match_document_chunks` and `match_memories`, for the current mode only, at most 5 matches. Each query embedding holds spend. Document parts are shown to the model by title, with no links (no `doc://`). The IDs that reached the model go in the context record (`memoryIds`, `documentChunkIds`), and "What was sent" shows them.
- **`propose_task` and `propose_reminder`.** They insert an `action_proposals` row with `conversation_id`, before `done`, through the schema checks of decision 0009. A reminder needs an ISO date and time with an offset; the server stores it in UTC.
- **`save_memory`.** It inserts a memory with `status: proposed`, `source: assistant` and `source_message_id` set to the user message, with its vector, so a memory the user keeps without editing can be found. The "Remember this?" card handles it.
- **No second card on Retry reply.** Before a write, the tool reads this turn's rows, in any status and with no row limit: proposals of this conversation created at or after the turn's user message (same payload), or memories linked to that user message (same text). If one exists, nothing new is written. A later turn that asks for the same task again gets a new card. Without a message link on proposals, the turn is found by time; a proposal of a later turn in the same conversation is never older than its user message, so it cannot hide a retry's row.
- **Deadline.** Tool runs (searches, embeddings, writes) get a signal that ends at the turn deadline, so the turn stays inside the reply claim lease. Outside the deadline: the first search and the memory embedding (`tests/unit/request-key.test.ts`).
- **When the own-data tools are offered.** Only when `detectToolIntent` (`src/server/assistant/tool-intent.ts`, a pure rule check next to the router) finds one of three intents in the message: `task_request` (remind, schedule, a task or to-do), `memory_request` (remember, save, keep in mind) or `own_data` (my notes, my documents, a file, what P-Dot knows or remembers about the user). Some Hindi-English phrases are covered ("yaad dila dena", "yaad rakhna", "mere notes"). The router then picks the standard tier with the intent as the route reason, and the line under the reply says that tools are on ("task or reminder request, tools on"). "Think harder" keeps the heavy tier. A plain message gets no tools and stays on the fast tier. Memories still go into every turn; they need no tool. The `route_reason` column accepts the new names (its check is a pattern), and an older Worker shows no route line for them.

## Titles

After the reply of a new conversation (its first message, and the title is still the one made from that message), one call on the fast tier makes a title: 32 output tokens, no reasoning, no hedge, at most 2 attempts and 15 seconds. Each attempt holds and settles spend. The title is cleaned and saved with the existing rename grant, only while the stored title is still the one the turn started with (the comparison is in the update). If the user renamed the conversation meanwhile, nothing changes and no event is sent. Otherwise a `title` event follows `done`. Any failure, a refused hold included, keeps the old title and sends no error. The step is on in `createAssistantDeps` (`titles: true`) and off in the default test deps.

## How to add a tool

1. Add the name to `AssistantToolName` in `src/types/api.ts`, and a status line in `src/features/chat/tool-status.ts`.
2. Write a `ToolSpec` in `src/server/assistant/tools/`: `name`, `description`, zod `args`, `kind` (`read` or `propose`), one line of `guidance` for the system prompt, `maxCallsPerTurn`, `offered(flags)`, `statusQuery(args)` and `run(args, context)`.
3. Add it to `TOOLS` in `src/server/assistant/tools/index.ts`.
4. If a request flag controls it, add the flag to `ToolFlags` and set it in `prepareChatTurn`, before the hold.
5. A tool that changes anything is `propose`: it writes an `action_proposals` row and never acts. A tool that reads private data outside P-Dot is `read_sensitive` in decision 0011 and needs an approval step first.

A connected Google account (Gmail, Calendar) comes in decision 0014 in another pull request, offered only when a "Use Google" toggle is on for the message, with every outside action behind approval.

## Server-side Auto is not in this change

Decision 0011 step 3 runs eligible proposals on the server and records `decided_by`. That needs a migration, so it is not here. The browser's interim auto-approval keeps working: it approves eligible proposals after `done`, through the decision route.

## Evals

`tests/evals/` holds Tirth's 50 cases in 5 groups, a grader and canned replies. `npm test` runs the mock suite: it calls no provider and writes no file. A pass checks the dataset, the grader and that retrieved text stays out of the system message; it says nothing about model quality. `npm run eval:live` runs the cases on a live model. It spends money (about $0.15 at most), needs `PDOT_EVAL_LIVE=1` and `NEBIUS_API_KEY` in the environment, calls no search provider, goes around the app's spend guard and never runs in CI. Its report goes to `tests/evals/reports/`, which Git ignores. Tirth's three other live scripts (RAG, memory and hallucination demos) used his tables and are not ported.

## Model audit and Nebius data terms (from Tirth's 0005, 2026-10-18)

Main's [decision 0005](0005-assistant-hub-proposal.md) says these terms were not checked. Tirth's record is the only source. Nothing below was checked again for this record.

| Claim | Status |
| --- | --- |
| Nano (`nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B`) returned a correct OpenAI-format tool call (`finish_reason: tool_calls`, ID `chatcmpl-tool-…`) for a one-tool request. | Live call by Tirth. Not repeated. Super, Ultra and Lightning were not tested with tools. |
| Nano context 262,144 tokens; Lightning 1,000,000. | From the catalog by Tirth. Not verified. |
| Prices of Nano, Lightning and Qwen3-Embedding-8B. | Match `pricing.ts`, which was checked on 2026-10-19. |
| Candidates not in the price table: Qwen3-30B-A3B-Instruct, Gemma 3 27B, DeepSeek V4 Flash, Hermes 4 405B, DeepSeek V4 Pro, Qwen3.5-397B, Kimi K3. | Not usable. Main refuses a model without a price. |
| Nebius does not use prompts or completions to train models. | From the Nebius legal quick guide, as read by Tirth. Not verified. |
| Requests can be cached for a short time in EU data centers (Finland) for speculative decoding. | Same source. Not verified. |
| Zero Data Retention is an account setting; with it on, nothing is stored after the request. | Same source. Not verified. Whether it is on for the owner's account is not known. |
| GDPR, ISO 27001, ISO 27701 and SOC 2 Type II. | Same source. Not verified. |

Check these on the [Nebius legal guide](https://docs.tokenfactory.nebius.com/legal/legal-quick-guide.md) before the Settings page states them.

## Limits

- The tools-off final pass sends no `tools` field after earlier tool messages. Tirth's live run did this on Nano. It is not checked on Super or Ultra.
- A tab opened before this deploy throws away the `status` event as an unknown type and stops the reply with "unreadable response". A reload fixes it. New pages skip unknown event types.
- A turn with tools offered costs more on the fast tier's messages, because it runs on the standard tier.
- The citation bracket fix runs on each chunk; a bracket pair split across two chunks stays as the model wrote it.
