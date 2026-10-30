# 0021: Several sources in one message, and the mode in the "+" menu

- Status: Proposed for build (2026-10-31).
- Changes: decision 10 of [0014](0014-google-sign-in-and-connection.md) ("One outside source for each message"), the section "One outside source for each message" of [0016](0016-mcp-connectors.md), and the sentence in [0018](0018-tavily-research-and-brief.md) that makes web search exclusive. Deep research and the morning brief stay exclusive.
- Related: [0006 spend guard](0006-global-spend-guard.md), [0013 tools](0013-ai-tools-and-scope.md), [0020 connectors v2](0020-connectors-v2.md).
- Code: `src/lib/schemas.ts`, `src/server/assistant/service.ts` (`prepareChatTurn`), `src/server/assistant/tools/registry.ts` (`checkToolCall`), `src/server/assistant/claim-guard.ts` (`forcedToolChoice`), `src/features/chat/composer-sources.ts`, `src/features/chat/ComposerTools.tsx`, `src/features/chat/ChatWorkspace.tsx`, `src/features/mode/`.

## Problem

The owner asked: "Let the user select multiple connectors and the mode from '+' while chatting."

Today a message can use only one kind of source: web search, or Google, or apps. Several apps together are allowed. The request schema, `checkToolCall` and the composer enforce this. The reason is privacy: a turn that read private data must not write a web search query, because the query could send private text to the search provider (decision 0014, decision 10). The rule is stronger than that reason needs. Two private reads (Google and Notion) add no path to the outside. A web search whose query is the user's own message, sent before any private read, adds no path either.

The site is live in hackathon judging. Single-source messages, the auto pick, Deep research, the morning brief and the approval cards must work as now.

## Decisions

| Item | Decision | Why |
| --- | --- | --- |
| Google with any apps | **Allowed** | All are private reads that go only to the user's own accounts. Mixing them adds no new leak path. |
| Web search with Google or apps | **Allowed, with the rules below** | The first search runs before any private read, and its query is the user's own message. The model gets no `web_search` tool in such a turn. |
| Deep research with Google or apps | **Refused** | It runs an advanced search and sends extracted page text to the model, and it has its own reply format. It stays a web-only mode. |
| Morning brief | **Unchanged** | It starts a new conversation and takes no other source. |
| Personal and Work in the "+" menu | **Added** | The same switch as the header, with the same effect. |
| "Think harder" | **Unchanged** | It is already in the "+" menu. The "Auto" button next to "+" is the approval mode, not the effort. No second effort control. |

## High-level design

### The web search rules in a mixed turn

1. **The first search uses the user's own words only.** `runChatTurn` sends `turn.userMessage.content` to Tavily, as for web search alone. It never builds a query from a tool result, a memory, a document or the history.
2. **The first search runs before any private read.** It runs before the first model call, and every Google and app read is a tool call of a model hop. So the search request cannot hold private text from this turn. Memory and document retrieval run at the same time as the search, but their text goes only into the prompt.
3. **No model-written search in the turn.** `ToolFlags.webSearchTool` is false when Google or an app is on (as today). So `web_search` is not offered, and `checkToolCall` refuses a call to it.
4. **No model-written search in the conversation after it.** The reply of a mixed turn gets route reason `google_request` (Google on) or `connector_read` (apps on), as today. `hasPrivateSourceReply` then turns `web_search` off in that conversation for good, and a failed check counts as yes.
5. **Defence in depth.** `checkToolCall` refuses a call to a tool with a `source` tag when the offered tools have both the `web` tag and a private tag (`google` or `connector`). Google and connector tools together pass.

What this does not change: the user can still type private text into a message with web search on. That is the user's own choice, as today.

### Several private sources

- `forcedToolChoice`: with one app and no Google, the first hop must call that app's first read, as today. With two or more private sources (several apps, or Google and an app), the first hop uses `"required"`, as for several apps today. With Google only, the rules of decision 0014 stay.
- Text caps stay with their owners: at most 12,000 characters of Google text and 12,000 characters of app text in one turn. A turn with both can send up to 24,000 characters of private text to the model.
- Call caps stay: each tool keeps its `maxCallsPerTurn`, a hop runs at most 3 calls, and a turn has 2 tool hops. With 5 sources on, the model can read at most 6 times. A later call gets "the limit is reached" and the model answers with what it has.
- The Google proposal guard (decision 0014, decision 11) is the same. A proposal needs the user's own words and the user's own addresses. App text or web text cannot make a card by itself.

### Spend

- The first Nebius hold prices the real prompt, the search result bytes (when web search is on) and every offered tool definition: Google and app tools together. One Tavily credit is held for the first search, as for web search alone.
- Each later attempt and hop reserves its own hold from its real messages (decision 0013), so the Google and app text is counted where it is sent. A hold above the $0.25 ceiling is refused before the call, never reduced.
- No new paid call. Google and the apps cost no money.

### The "+" menu

- **Sources** are checkboxes with the brand mark: "Search the web", "Use Google" and "Use <app>" for each connected app. Any set can be on. A click keeps the menu open, so the user can tick several. Each source that is on shows a chip above the message box.
- **Deep research** turns Google and the apps off, and it says so in its row: "Turns off Google and apps." Turning on Google or an app turns Deep research off. Plain web search and Deep research still replace each other.
- **Think harder** stays where it is.
- **Personal and Work** are two radio rows at the end of the menu. A pick does what the header switch does: it sets the mode cookie, and on `/chat` it opens a new chat in that mode. A conversation keeps its mode, so with a conversation open the row says "This chat stays <mode>. <Other> starts a new chat." The draft text moves to the new chat. It stays in the browser memory only, never in the address or in storage.

### Auto pick from the message

`autoSources` still runs only when the user picked no source. It can now turn on several sources: each connected app that the message names, and Google when the message is about email or the calendar. With an app named, Google needs a strong word ("email", "inbox", "Gmail", "calendar", "my schedule", "free time"). A weak word with an owner ("my meeting notes in Notion") does not add Google. So "Check my email and my Notion page" turns on Google and Notion, and "Find my meeting notes in Notion" turns on Notion only. The auto pick never turns on web search.

## Design checklist

- **C1 Trust boundaries:** The search query is the user's own message, sent before any private read. Private text goes only to the model and to the user's own accounts. Web text, Google text and app text are untrusted blocks. The proposal guard reads only the user's own message.
- **C2 Concurrent actors and retries:** No new state. Retry sends the sources of the message it retries (as today), so a retry of a mixed message is a mixed retry.
- **C3 Unknown outcomes and halfway states:** No new writes. A failed search gives the "search failed" line, and the private reads still run.
- **C4 Tests that fail on the mistake:** a schema test for each allowed and refused set; a service test that a mixed turn sends one search with the user's message, offers no `web_search`, refuses a scripted `web_search` call and never sends the private sentinel to the search fake; a `checkToolCall` test for web with a private tag; a forced choice test for Google with an app; a hold test that the mixed hold prices both the search bytes and the tool definitions; UI toggle tests.
- **C5 Spend and quota:** One chat quota unit and one Tavily credit for each mixed message. The Nebius holds follow decision 0013.
- **C6 Claims in docs and UI text:** The rows say what the code does. The "Search the web" row in a conversation that read private data keeps "only with your own words".
- **C7 Input bounds and parsers:** The schema keeps the app list unique and at most the number of apps. No new input.
- **C8 Deploy order and grants:** No migration. An older browser sends one source, which the new server accepts. A new browser can send a mixed request to an older server for a short time after the deploy, which gets the old 400. This pull request merges after #45.
- **C9 Merge hygiene:** Stacked on `om/backend` (#45), because #45 changes the connector code. Shared files: `CHANGELOG.md`, `src/features/chat/ChatWorkspace.tsx`.
- **C10 Time:** No change.
- **C11 Model and stream semantics:** No change to the hop loop. In a mixed turn the search event comes first, then the tool status events.
- **C12 UI state ownership:** The sources stay one-message state in `ChatWorkspace`. The mode stays in the cookie. The draft that moves to the new chat is held in one module variable and read once.
- **C13 Proof in the real runtime:** Unit tests with fakes. Not proven: a real mixed turn with Tavily, Google and an app on the live models.

## What this leaves out

- No shared private text cap across Google and the apps. Each keeps its own 12,000 characters.
- No more tool hops or calls for a turn with many sources.
- No change to Deep research, the morning brief or the approval cards.
- No mode change for an existing conversation.

## Limits

- A worst-case turn (a full history of 3 or 4 byte characters, documents, web results and all tool definitions) on the heavy tier can reach the $0.25 hold ceiling. Then the turn is refused with "This request is too large to answer", before any call. Plain text is far below it.
- With 5 sources on, 6 reads can be too few to read every source. The model says what it could not read.
