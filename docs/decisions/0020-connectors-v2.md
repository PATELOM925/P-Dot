# 0020: Connectors v2: GitHub, Telegram, "Open on your phone", and the planned ones

- Status: Proposed for build (2026-10-30). Everything in this record is off until the owner sets its settings. With no new settings, the Connectors page and chat look and work as on main.
- Related: [0010 installable app](0010-pwa-and-device-pairing.md), [0011 approval modes](0011-approval-modes.md), [0014 Google](0014-google-sign-in-and-connection.md), [0016 MCP connectors](0016-mcp-connectors.md), [DEPLOYMENT.md](../DEPLOYMENT.md) ("Expand, then contract").
- Code: `src/server/mcp/catalog.ts` (GitHub), `src/server/telegram/`, `src/app/api/telegram/webhook/route.ts`, `src/app/api/connectors/telegram/`, `src/features/connectors/`, `src/components/ui/QrCode.tsx`.

## Problem

The owner asked for more connectors: Telegram, GitHub, Vercel, phone, WhatsApp, and use across laptop, desktop and mobile. The site is live in hackathon judging. A new connector must not change a judging flow, and each one must stay off until its settings exist.

## Facts checked on 2026-10-30

| Item | MCP server | OAuth | Scopes or permissions | Limits | Cost | Business checks |
| --- | --- | --- | --- | --- | --- | --- |
| GitHub | Official remote server. Read-only URL `https://api.githubcopilot.com/mcp/readonly` (fetched: its resource metadata names this URL as `resource`). [1] | Authorization server `https://github.com/login/oauth` (fetched metadata: S256, `iss` in the callback, refresh grant). **No DCR and no CIMD.** A host app must register its own GitHub App or OAuth App, and the code exchange needs the client secret. [2][3] | An OAuth App has no read-only scope for private code (`repo` can write). A GitHub App has fine-grained permissions, so it can be read only. GitHub App user tokens end after 8 hours and come with a refresh token for 6 months. [4][5] | REST: 5,000 requests per hour for each user. Search: 30 requests per minute. Limits of the MCP server itself: not published. [6] | The server is "available to all GitHub users regardless of plan type". [7] | None. |
| Vercel | Official, `https://mcp.vercel.com`. [8] | Fetched metadata: issuer `https://vercel.com`, CIMD supported, DCR endpoint, S256, revocation. | `openid`, `offline_access`. No read-only mode: a connection has the same access as the user's Vercel account. [8] | Not published. | All plans. | **Vercel accepts only AI clients that it reviewed and approved** (a review form). [8] |
| Telegram | None official. The Bot API. [9] | Not OAuth. One bot token. A user must message the bot first; a bot cannot start a chat. [10] | Not applicable. | About 1 message per second in one chat, about 30 per second for the bot. `sendMessage` text: 1 to 4,096 characters. [11] | Free. [11] | None. |
| WhatsApp | Meta has a beta "WhatsApp Business Tools MCP". It is an admin tool for developers, not a channel for a user's assistant, and not read only. [12] | Not applicable to the channel. | Not applicable. | A new business portfolio reaches 250 users in 24 hours outside the service window. [13] | Per message. From 2026-10-01, utility templates in the service window and service messages are charged again (1,000 free service messages each month). [14] | A business portfolio, a registered phone number, a display name, a payment method, approved templates, and user opt-in. Business verification to reach more users. [13][15] |
| Phone calls | None. | Not applicable. | Not applicable. | Not applicable. | A telephony provider charges per minute. | Number registration and call rules for each country. |
| Second device sign-in | Not applicable. | `auth.admin.generateLink` needs the service-role key. `signInWithOtp` with the publishable key sends an email and returns no link. Supabase has no cross-device or device-code sign-in. Refresh tokens are single use with reuse detection. [16][17][18] | Not applicable. | Not applicable. | Not applicable. | Not applicable. |
| Install prompt | Not applicable. | Not applicable. | Not applicable. | `beforeinstallprompt` exists only in Chromium browsers. iPhone and iPad install from the Share menu (iOS 16.4 or later). [19][20] | Free. | None. |

## Decisions

| Item | Decision | Why |
| --- | --- | --- |
| GitHub | **Build behind config** | The server is official and free, and its read-only URL fits decision 0016. It needs a GitHub App that the owner registers, so it stays off until `GITHUB_MCP_CLIENT_ID` and `GITHUB_MCP_CLIENT_SECRET` are set. |
| Telegram | **Build behind config** | Free, small and safe with one bot. It stays off until the bot token, the bot username and the webhook secret are set. |
| Open on your phone (QR) and install | **Build now** | It needs no secret and no provider. It shows the site address only (see "Why the QR has no sign-in link"). |
| Vercel | **Planned (coming soon)** | Vercel must review and approve P-Dot as a client first. A connection would also have the user's full Vercel access, with no read-only mode on the server side. |
| WhatsApp | **Planned (coming soon)** | It needs Meta business setup, approved templates, opt-in and a payment method, and messages cost money. Telegram covers "send to my phone" for now. |
| Phone calls | **Planned (coming soon)** | No provider is chosen, calls cost money, and each call is a consequential action that needs its own decision. |
| Telegram answers to messages | **Planned** | To answer a message, the webhook must act as the user without the user's session. That needs the service-role key or a stored user token, and `AGENTS.md` forbids the service-role key. The bot gives a fixed reply instead. |
| Device pairing (act on a laptop or phone) | **Planned** (unchanged from decision 0010) | It needs a device agent with its own security review. |

## High-level design

### What the user sees

- **Connectors, with no new settings:** the page is the same as on main. "Coming soon" lists Telegram, GitHub, Vercel, WhatsApp and Phone calls, and "Your devices". A new card "Open on your phone" shows a QR code of the site address, with install steps.
- **GitHub is set up:** a GitHub card joins "Your accounts" and leaves "Coming soon". It works like the Notion card (decision 0016): Connect, Disconnect, the tools that are ready. Chat offers "Use GitHub" when it is connected. A message that names GitHub turns it on.
- **Telegram is set up:** a Telegram card joins "Your accounts". **Link Telegram** shows a button that opens the bot, and a QR code of the same link for a phone. The user selects Start in Telegram. The bot answers with a button "Finish linking in P-Dot". That opens a P-Dot page that shows the Telegram name and a **Link this chat** button. After that, each P-Dot reply in chat has **Send to Telegram**. It opens an approval card with the exact text and the chat name. Only **Send** sends. **Unlink** on the card deletes the link.

### Architecture

```text
Browser
  Connectors: GitHub card (MCP, decision 0016), Telegram card, "Open on your phone" (QR, install)
  Chat: "Use GitHub" in the + menu; "Send to Telegram" approval card under a reply
     |  same origin, Supabase session cookie
Cloudflare Worker (OpenNext)
  MCP routes (unchanged paths) .................. GitHub uses a confidential client: ID and secret from env
  POST /api/connectors/telegram/link ............ account -> config -> new code -> start_telegram_link -> deep link
  GET  /connectors/telegram/confirm?t=… ......... session -> open the sealed proof -> show the Telegram name
  POST /api/connectors/telegram/confirm ......... account -> proof -> confirm_telegram_link (code hash, sealed chat)
  POST /api/connectors/telegram/unlink .......... account -> delete own row
  POST /api/connectors/telegram/send ............ account -> body -> quota -> claim_telegram_send(key) -> sendMessage
  POST /api/telegram/webhook .................... secret header -> parse -> reply in the webhook answer (no DB, no fetch)
Supabase Postgres (RLS, user session): connected_accounts (+ 'github'), telegram_links (new)
Telegram Bot API: sendMessage (only from /send, after approval)
GitHub: github.com/login/oauth, api.githubcopilot.com/mcp/readonly
```

### Trust boundaries

| Input or effect | Source | Check | Where |
| --- | --- | --- | --- |
| Webhook caller | Anyone on the internet | `X-Telegram-Bot-Api-Secret-Token` equals `TELEGRAM_WEBHOOK_SECRET` in constant time, else 401 and nothing else runs. Body at most 64 KB, zod. Only a private chat message from a person (not a bot). | `src/app/api/telegram/webhook/route.ts`, `src/server/telegram/webhook.ts` |
| Webhook effect | Telegram | No database access and no outbound call. The only effect is one reply to the chat that wrote, in the webhook answer. It is fixed text, or a button with a sealed proof for `/start <code>`. | same |
| Link proof | The webhook | AES-256-GCM sealed with `CONNECTOR_TOKEN_ENCRYPTION_KEY`, associated data `pdot:telegram_link_proof`. It holds the chat ID, the name, the SHA-256 of the code and an expiry of 10 minutes. | `src/server/telegram/seal.ts` |
| Link confirm | The browser | A verified session with an account, same origin, a proof that opens and has not expired, and `confirm_telegram_link`, which matches the hash of the user's own pending code in the database, once, before it ends. A proof for another user's code matches no row. | `/api/connectors/telegram/confirm`, migration |
| Stored chat | The user's own row | The chat ID is sealed, bound to the user ID (`pdot:telegram_links:<user>`). A user can write the column, but only a value that the Worker sealed for that user opens. So a user cannot point the bot at another person's chat. | `src/server/telegram/seal.ts` |
| Send | The browser | Same origin, account, body zod (text 1 to 4,000 characters, a UUID key), chat quota, `claim_telegram_send(key)` (one send for each key), then one `sendMessage` with plain text (no parse mode). The model cannot call it: there is no model tool. | `/api/connectors/telegram/send` |
| GitHub client secret | Env | Only in the code exchange and the refresh body, to the token endpoint from discovery, which must be `https://github.com`. Never in the sealed state, the bundle, a log or the browser. | `src/server/mcp/oauth.ts`, `src/server/config.ts` |
| GitHub tool arguments | The model | Decision 0016 rules. A search is `user_phrase`. A repository (`owner/name`) or a file link must be in the user's current message (`turn_ids`). | `src/server/mcp/catalog.ts`, `outbound.ts` |

### Why the QR has no sign-in link

A one-time sign-in link for another device needs `auth.admin.generateLink`, which needs the service-role key. `AGENTS.md` forbids that key. Copying the session's refresh token into a QR code is not safe: the token is long-lived, a photo of the screen would copy it, and Supabase's reuse detection can end both sessions. So the QR code holds the site address only (`<SITE_URL>/today`), and the phone signs in by itself (email, password or Google). Accounts already sync, because all data is on the server.

### Approval effects

- GitHub reads are `read_sensitive`, as in decision 0016: the toggle for one message is the approval.
- A Telegram send is a message to the user's own chat. Each send needs a press on **Send** on an approval card that shows the exact text and the chat name. Auto mode never sends. There is no model tool, so a model cannot ask for a send and a page cannot send without a click on the card.

## Low-level design

### GitHub in the MCP catalog

| Field | Value |
| --- | --- |
| `resource` | `https://api.githubcopilot.com/mcp/readonly` |
| `issuer` | `https://github.com/login/oauth` |
| `authOrigins` | `https://github.com` |
| Client | Confidential. `GITHUB_MCP_CLIENT_ID` and `GITHUB_MCP_CLIENT_SECRET`. No CIMD, no DCR. |
| Scope sent | None (a GitHub App ignores scopes). P-Dot stores the label `read` (new migration). |
| Revocation | Not in the metadata, so Disconnect deletes the row and says that GitHub did not confirm. |

| P-Dot tool | Remote tool | Arguments P-Dot sends | Rule |
| --- | --- | --- | --- |
| `github_search_issues` | `search_issues` | `{ query, perPage: 10 }` | `user_phrase`, 1 call |
| `github_list_pull_requests` | `list_pull_requests` | `{ owner, repo, state: "open", perPage: 10 }` from `repo: "owner/name"` | `turn_ids`: `owner/name` or a `github.com/owner/name` link in the user's message |
| `github_read_file` | `get_file_contents` | `{ owner, repo, path, ref }` from a `github.com/<owner>/<repo>/blob/<ref>/<path>` link | `turn_ids`: the link must be in the user's message |

Changes to the shared MCP code, each one a no-op for Notion, Linear and Todoist:

- `McpServer.client` is `{ kind: "public" }` or `{ kind: "confidential" }`. Connect uses the env client ID for a confidential server and adds `client_secret` to the code exchange and the refresh.
- `McpServer.scope` can be null: no `scope` parameter, and the stored scopes are the catalog's `acceptedScopes`.
- `mcpServerReady(id)`: the sealing key, and for a confidential server also its client ID and secret. The Connectors page, the chat page and `available()` in chat use it, so a server without its settings is not shown and not offered.
- The prompt note for apps that are off keeps the three apps on main. A config-gated app is not named in it (limit L4).

### Migrations (both expand only)

1. `20261102000000_telegram_links.sql`: table `telegram_links` (one row for each user), RLS for the owner, no anonymous insert or update, column grants, and three SECURITY INVOKER functions: `start_telegram_link`, `confirm_telegram_link`, `claim_telegram_send`. Times come from the database clock.
2. `20261102010000_github_connector.sql`: `connected_accounts` accepts provider `github` with the scope `read`. The checks only get wider, and every row and write of the live code still passes.

### Telegram

- **Settings:** `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_WEBHOOK_SECRET` (32 to 256 of `A-Z a-z 0-9 _ -`), and the existing `CONNECTOR_TOKEN_ENCRYPTION_KEY`. A missing or bad one gives "not set up". The log names a bad variable, never its value.
- **Code:** 24 random bytes, base64url (32 characters). The database stores only its SHA-256. The deep link is `https://t.me/<bot>?start=<code>`.
- **Webhook:** `/start <code>` gives a button "Finish linking in P-Dot" to `<SITE_URL>/connectors/telegram/confirm?t=<proof>`. Any other message gets a fixed text that says what the bot does. The bot never reads or stores message text. The reply is in the webhook answer (`{ method: "sendMessage", … }`), so the webhook needs no fetch and no bot token.
- **Send:** the browser makes a new UUID for each approval card. A repeat with the same key (double click, retry) matches no row and sends nothing. Telegram answers: 2xx is sent; 400 or 403 is "not sent" (for example, the user blocked the bot); 429 is "not sent, try later"; a timeout, a network error or a 5xx is "unknown", and the card tells the user to check Telegram before a new send.
- **Proxy:** the matcher skips `/api/telegram/webhook`, which has no session.

### Open on your phone

`QrCode` renders the matrix from `uqr` (MIT, no dependencies) as SVG rectangles, with no HTML string. The card also has the install button (Chromium) and the iPhone steps from decision 0010.

### Tests

| Test file | What it proves |
| --- | --- |
| `tests/integration/sql-gate-telegram.test.ts` | Both grant modes: one link for each code, expiry, a new link keeps the old chat until it finishes, one send for each key, owner only, anonymous and `anon` refused, bad hash and ciphertext refused, owner and creation time not writable |
| `tests/integration/sql-gate-github.test.ts` | `github` with `read` saves; other scopes refused; the live providers unchanged |
| `tests/unit/telegram-webhook.test.ts` | Secret header: missing, wrong, other length, correct; fixed replies; `/start <code>` proof opens and holds the hash, not the code; bots and group chats ignored; no fetch; no message text in logs |
| `tests/unit/telegram-routes.test.ts` | Link, confirm, unlink and send: not set up, anonymous, cross origin, expired proof, proof of another user, the approval gate (no send without a key and a linked chat, one send for each key), Telegram errors, write-fault sweep of the send route |
| `tests/unit/mcp-github.test.ts` | A fake GitHub: Connect uses the env client ID and no CIMD, the secret goes only to the token endpoint, `iss` required, scope label stored, refresh sends the secret, tool argument rules for `owner/name` and file links |
| `tests/unit/connectors-config.test.ts` | Each new connector is "not set up" or hidden without its settings, and the page lists it under "Coming soon" |

## Design checklist

- **C1 Trust boundaries:** Table "Trust boundaries". The webhook has no session, so it reads and writes nothing and sends nothing except one reply to the sender. The only path from a Telegram chat to an account is a code that the signed-in user made, proved by the chat and accepted by the same user's session. The sealed chat stops a user from pointing the bot at another chat. GitHub follows decision 0016, plus the secret rule.
- **C2 Concurrent actors and retries:** Two link starts: the last code wins, the first proof matches no row. Two confirms with one proof: the first clears the hash, the second matches no row. Two sends with one key: `claim_telegram_send` is one conditional update, so one wins. A send and an unlink: the claim reads the row in the same statement, so the send uses the chat that was linked when it was claimed. GitHub: the refresh fence of decision 0016.
- **C3 Unknown outcomes and halfway states:** A Telegram send that times out is "unknown". The key is already used, so a retry with the same card sends nothing, and the card says to check Telegram. The send route writes the quota and the claim before the call; a claim that is stored and then lost refuses the retry (nothing sent twice). A confirm that fails leaves the old link and the pending code as they were.
- **C4 Tests that fail on the mistake:** The SQL gate fails when the expiry, the anonymous check or the key check is removed (checked by mutation). The webhook test fails on a wrong secret that is accepted. The send test fails when a second send with one key reaches the fake Telegram.
- **C5 Spend and quota:** No paid provider call. A send takes one unit of the chat quota. Link, confirm and unlink write only the user's own row. Telegram and GitHub are free.
- **C6 Claims in docs and UI text:** The cards say only what the code does. Real connects to GitHub and Telegram are not verified in this PR (PR body label).
- **C7 Input bounds and parsers:** Webhook body 64 KB; text 4,096; name cut to 64 characters with control characters removed. Code 32 characters. Proof at most 1,024 characters. Send text 1 to 4,000 characters. Telegram answer 16 KB, zod. GitHub as decision 0016.
- **C8 Deploy order and grants:** Both migrations only add. The new code works on the old schema: without settings it does nothing, and with settings but without the migration the link and the GitHub save fail with "error" and store nothing. The owner sets the settings only after the migrations are in the Supabase history. This PR merges and deploys on its own, not with other PRs.
- **C9 Merge hygiene:** One PR from `main`. Shared files: `CHANGELOG.md`, `tests/integration/frozen-migrations.sha256`, `src/app/(workspace)/connectors/page.tsx` (the brand-logo work on `om/backend` also changes the cards; the card markup keeps the name in `<span className="chip">` inside the heading).
- **C10 Time:** The code expiry and the link time use the database clock. The proof expiry uses the Worker clock, and the database checks the code expiry again.
- **C11 Model and stream semantics:** No change to the hop loop. GitHub tools are three more connector tools. Telegram is not a tool.
- **C12 UI state ownership:** The approval card state is local to one reply and holds one key. Link and connection state comes from the server on each page load.
- **C13 Proof in the real runtime:** Unit and SQL gate tests with fakes. Not proven: a real GitHub App connect, a real bot, and the OpenNext Worker runtime.

## Limits

- **L1.** The bot cannot answer a message with P-Dot's assistant (see Decisions).
- **L2.** No scheduled sends: the morning brief and reminders go to Telegram only when the user presses Send on a reply.
- **L3.** A Telegram send does not show in Activity. It is not an action proposal.
- **L4.** When GitHub is off for a message, the prompt does not tell the model to suggest turning it on.
- **L5.** A GitHub App reads private repositories only where the user installed it. Public repositories work after Connect.
- **L6.** `github_read_file` takes the first path part after `blob/` as the ref. A branch name with `/` reads the wrong file or fails.
- **L7.** GitHub's `iss` callback parameter and its handling of `resource` are PLAUSIBLE until a real connect. A mismatch fails the connect closed.
- **L8.** On a laptop without Telegram, the deep link opens the Telegram web page. The QR code on the card opens Telegram on the phone.

## Sources

1. https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md and `https://api.githubcopilot.com/.well-known/oauth-protected-resource/mcp/readonly` (fetched 2026-10-30)
2. `https://github.com/.well-known/oauth-authorization-server/login/oauth` (fetched 2026-10-30) and https://docs.github.com/en/apps/github-authentication-discovery-endpoints
3. https://github.com/github/github-mcp-server/blob/main/docs/policies-and-governance.md
4. https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps
5. https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens
6. https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api and https://docs.github.com/en/rest/search/search
7. https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp-in-your-ide/set-up-the-github-mcp-server
8. https://vercel.com/docs/agent-resources/vercel-mcp and `https://vercel.com/.well-known/oauth-authorization-server`
9. https://core.telegram.org/bots/api
10. https://core.telegram.org/bots
11. https://core.telegram.org/bots/faq
12. https://developers.facebook.com/documentation/mcp/whatsapp-business-tools-mcp
13. https://developers.facebook.com/documentation/business-messaging/whatsapp/messaging-limits
14. https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing
15. https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/overview
16. https://github.com/supabase/supabase-js/blob/master/packages/core/auth-js/src/GoTrueAdminApi.ts
17. https://supabase.com/docs/guides/auth/auth-email-passwordless
18. https://supabase.com/docs/guides/auth/sessions
19. https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/How_to/Trigger_install_prompt
20. https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable
