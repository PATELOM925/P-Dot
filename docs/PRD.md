# P-Dot — Personal Assistant Bot

Status: Draft for review

Date: 2026-10-09 (updated 2026-10-14; scope updated 2026-10-30, decision 0013)

Phase: MVP implementation in progress (authorized 2026-10-14)

## 1. Product summary

P-Dot is a web-based personal assistant that helps an individual ask questions, research topics, draft content, and plan everyday work through a conversational interface. Nebius provides model inference, Tavily provides web search when requested, and Cloudflare Workers hosts the frontend and backend API.

The initial product supports assistance within a conversation. It does not act on its own: it can propose a task, a reminder or a memory, and each one waits for the user's approval. It does not execute tasks in external applications without that approval.

## 2. Confirmed requirements and assumptions

Confirmed by the user:

- A frontend webpage with login-related functionality.
- A backend hosted on Cloudflare (originally Vercel; changed 2026-10-15, see `docs/decisions/0004-cloudflare-workers-deployment.md`).
- An AI layer using Nebius and Tavily.
- Repository instructions, an initial directory structure, and this PRD.
- Backend and minimal frontend implementation (requested 2026-10-14).
- Supabase for authentication and database, and streamed assistant replies (decided 2026-10-14; see `docs/decisions/`).

Proposed assumptions requiring review before implementation:

- Next.js and TypeScript will support the web UI and API in one repository.
- The MVP is text-based and supports multiple private user accounts.
- Email/password authentication, saved conversation history, and basic profile settings are sufficient initially.
- Users explicitly enable web search for a message; automatic search routing can follow later.
- Tools, memory and documents are in scope with the limits in "Tools, memory and documents" below (accepted 2026-10-30, [decision 0013](decisions/0013-ai-tools-and-scope.md)).

## 3. Target user and problem

The initial target is an individual who wants one workspace for everyday questions, research, writing, and planning. Current workflows require switching between a search engine, an AI chat tool, and notes. P-Dot should provide a straightforward conversation experience with accessible sources and private history.

## 4. Goals

- Make it easy to start a useful conversation after signing in.
- Answer general questions through Nebius-hosted inference.
- Support research with Tavily results and visible source links.
- Let users revisit and delete their own conversations.
- Make loading, failures, search use, and data retention understandable.

## 5. MVP scope

### Authentication and account access

- Landing page with sign-in and signup entry points.
- Signup, login, logout, email verification if required by the provider, and password recovery.
- A trial without an account, for the hackathon judges ([decision 0015](decisions/0015-judge-demo-mode.md)). A trial user is a Supabase anonymous user with lower per-user limits than an account. A trial cannot set a password or connect other accounts, and its chats do not move to a new account.
- Protected workspace and server-enforced authentication for all private endpoints.
- Clear validation and authentication error states without revealing whether an account exists.

Acceptance: A signed-out user cannot access private conversations or invoke the assistant API. Signing out invalidates access from the current session. A user can complete the configured recovery flow.

### Assistant conversations

- Start a new conversation, send a message, and receive a model-generated reply.
- Use recent conversation context within a documented token budget.
- Show pending and failed states, preserve the user's draft on failure, and allow explicit retry.
- Render output safely. Markdown support is optional; arbitrary HTML execution is prohibited.
- No fabricated completion states when providers are unavailable.

Acceptance: An authenticated user can complete a multi-turn exchange. An invalid request or upstream failure produces a useful error without exposing credentials or raw provider internals.

### Web research

- Offer an explicit web-search toggle for each request.
- Retrieve a bounded number of results through Tavily and pass relevant excerpts to Nebius.
- Display source titles and safe HTTP(S) links alongside the response.
- Distinguish retrieved source material from model interpretation. Do not present source links as proof of claims they do not support.
- Clearly report search failures; do not silently describe an answer as web-grounded if retrieval failed.

Acceptance: Search-enabled requests show the retrieved sources used as context. Search-disabled requests do not call Tavily. Retrieved content cannot authorize tool use or override application instructions.

### Tools, memory and documents

Accepted on 2026-10-30 ([decision 0013](decisions/0013-ai-tools-and-scope.md)).

- Tools act only with the user's approval first. A tool that changes anything writes a proposal; the action runs only after the user approves it. Read tools (web search, the user's own memories and documents) change nothing.
- The assistant may call web search only when the user turned search on for the message.
- Memory is visible to the user. The user can add, edit, move and delete each memory. A memory that the assistant suggests waits until the user keeps it, and only kept memories are used in replies.
- Documents are plain text or Markdown that the user adds. The assistant can search them in the current mode.
- Retrieved memories, documents and web results are untrusted data. They go in the user turn, never in the system instructions, and cannot authorize an action.
- The screen shows which tool runs. "What was sent" shows which memories and document parts a reply used.
- A connected Google account (Gmail, Calendar) is being added in decision 0014 by another pull request. Every outside action stays behind approval.

Acceptance: No tool changes data or an outside account before the user approves it. Search-disabled requests do not call Tavily, by tool or otherwise. Retrieved text cannot change the system instructions.

### Conversation history

- Persist conversation messages under the authenticated account.
- List and reopen previous conversations.
- Allow users to delete a conversation through a clear confirmation step.
- Enforce ownership for listing, reading, writing, and deletion.

Acceptance: User A cannot access or modify user B's data, including through direct API requests with guessed IDs. Deleted conversations disappear from active storage; backup retention must be documented.

### Basic settings

- Display account identity and provide logout.
- Explain which content is sent to inference and search providers.
- Document history retention and deletion behavior before public release.

## 6. Primary journey

1. A visitor opens the landing page and creates an account or signs in.
2. The user enters the workspace and starts a conversation.
3. The user enters a question and optionally enables web search.
4. The backend verifies the session, validates input, and checks the user's usage limit.
5. If requested, the backend retrieves web context from Tavily.
6. The backend invokes Nebius and returns the answer and any source references.
7. The user continues the conversation, reopens it later, or deletes it.

## 7. Nonfunctional requirements

- Security: TLS, server-only secrets, verified authentication, ownership enforcement, and safe output rendering.
- Privacy: Avoid logging raw conversations, tokens, and search queries. Document provider data handling and retention choices.
- Reliability: Bound input size, history context, search result count, output tokens, and upstream duration. Handle provider throttling and timeouts explicitly.
- Cost: Enforce a persistent per-user limit before paid provider calls. Set provider account budgets before public access.
- Accessibility: Keyboard-operable controls, visible focus, form labels, readable contrast, and accessible status messages.
- Responsiveness: Usable layouts on mobile and desktop.
- Operations: Health endpoint without secrets; structured request IDs, duration, and status metadata for debugging.
- Performance: Define measurable latency targets after testing a selected model; do not promise unmeasured response times.

## 8. Out of scope for MVP

- Actions without the user's approval, purchases, and outside account changes other than those decision 0014 adds behind approval.
- Background reminder delivery and scheduled jobs.
- Binary file uploads (for example PDF or Office files), images and other multimodal input.
- Memory the user cannot see or edit, and inferred personal profiles. Session summaries wait for their own decision.
- Team workspaces, shared conversations, billing, and native mobile apps.
- Custom model training, fine-tuning, or a self-hosted inference service.

## 9. Success measures

Track only the minimum privacy-preserving metadata needed to evaluate:

- Signup-to-first-successful-conversation completion.
- Successful assistant requests versus validation, authentication, and provider failures.
- Response latency and provider cost per completed request.
- Search-enabled response usefulness through optional user feedback.
- Returning users and reopened conversations, if analytics is approved.

Numerical targets and analytics tooling remain undecided until a baseline and privacy approach are agreed.

## 10. Delivery phases

1. Planning: Review this PRD, repository instructions, structure, and unresolved decisions.
2. Foundation: Initialize the approved framework, environment validation, UI shell, and authentication.
3. Assistant: Add authenticated chat orchestration and the Nebius adapter.
4. Research and history: Add Tavily retrieval, source display, persistence, and deletion.
5. Release preparation: Verify access boundaries, accessibility, error handling, usage limits, and Cloudflare deployment configuration.

Implementation of phases 2–4 was authorized on 2026-10-14; phase 5 (release preparation) remains.

## 11. Open decisions

Resolved on 2026-10-14:

- Authentication and database provider: Supabase ([decision 0001](decisions/0001-supabase-auth-and-database.md)).
- Streaming versus complete-response delivery: streaming ([decision 0002](decisions/0002-streaming-responses.md)).

Still open (provisional implementation defaults are listed in [decision 0003](decisions/0003-provisional-defaults.md)):

- Nebius model identifier, model availability, inference budget, and context window.
- Conversation retention, backup retention, and account deletion policy.
- Per-user request limits, total service budget, and initial audience size.
- Hosting region and any data-residency requirements.
- Resolved on 2026-10-30: tasks, reminders, memory and documents are in scope, behind approval ([decision 0013](decisions/0013-ai-tools-and-scope.md)).

## 12. Release acceptance

The MVP is ready only when signup/recovery/login/logout work, the assistant API rejects unauthorized access, both provider paths are verified with real credentials, conversation ownership is tested, history and deletion work, and documented validation passes in a Cloudflare preview deployment. None of these conditions is claimed complete yet: the implementation has been verified only with unit tests and mocked providers.
