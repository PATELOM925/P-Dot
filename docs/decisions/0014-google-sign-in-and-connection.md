# 0014: Sign in with Google, and connect Google for Gmail and Calendar

- Status: Proposed for build (2026-10-30). The owner asked for both parts on 2026-10-30.
- Related: [0001 Supabase](0001-supabase-auth-and-database.md), [0009 actions and the action log](0009-memory-documents-actions.md), [0011 approval modes](0011-approval-modes.md), [0012 resend idempotency](0012-resend-idempotency.md), [DEPLOYMENT.md](../DEPLOYMENT.md) ("Expand, then contract", "One-time setup").
- Scope note: the PRD lists email sending and calendar edits as out of scope for the MVP. The owner changed this on 2026-10-30. The PRD edit belongs to the tool-loop work (decision 0013), so this record does not change `docs/PRD.md`.

## Problem

1. A user can sign in only with an email and a password.
2. P-Dot cannot read the user's Gmail or Google Calendar, and it cannot send an email or create an event for the user.

## Decision in short

- **Sign in with Google** uses Supabase Auth (OAuth with PKCE through `@supabase/ssr`). Email and password sign-in stays.
- **Connect Google** is a separate step on the Connectors page. Our own server routes run the OAuth flow with Google. The refresh token is stored encrypted (AES-GCM) in a new generic table, `connected_accounts`.
- **Reads** (Gmail search and read, Calendar list) are `read_sensitive`. They run only for a message where the user turned on "Use Google". What they return is untrusted data.
- **Writes** (`send_email`, `create_calendar_event`) are new action kinds with the effect `external`. They always wait for approval. The Worker calls Google after a database claim (`executing`), and a retry never sends twice.
- **No service-role key.** Every query runs as the signed-in user under RLS.

## 1. Sign in with Google

- The login and signup pages get a "Continue with Google" button. A server action calls `supabase.auth.signInWithOAuth({ provider: "google", options: { redirectTo } })` with the server client. `@supabase/ssr` puts the PKCE code verifier in a cookie and returns the Google URL. The action redirects to it.
- `redirectTo` is `${SITE_URL}/auth/callback?next=<path>`. The `next` path goes through the same check as the email flow (a same-site path only).
- New route `GET /auth/callback`. It calls `exchangeCodeForSession(code)` and redirects to `next`. On any error (no code, a Google error, an exchange error) it redirects to `/login?error=oauth`. The login page then shows one message: "Google sign-in did not finish. Try again." The message is the same for every cause, so it does not show whether an account exists.
- Scopes: we do not pass `scopes`. The Supabase Google provider asks for `email` and `profile` only ([source](https://github.com/supabase/auth/blob/master/internal/api/provider/google.go)). Sign-in never asks for Gmail or Calendar.
- The proxy does not protect `/auth/callback`, so a signed-out browser reaches it. It is not in the "signed out only" list either, so a signed-in browser that links Google also reaches it. A test checks both.
- **Account linking.** Supabase links a new identity to an existing user with the same email address, and removes unconfirmed identities of that user ([identity linking](https://supabase.com/docs/guides/auth/auth-identity-linking)). On 2026-10-19 "Confirm email" was turned off (DEPLOYMENT.md), so a password sign-up is confirmed without proof that the person owns the address. See "Risks".
- Previews: `SITE_URL` is the production address, so Google sign-in from a Preview returns to production, where the PKCE cookie does not exist. The sign-in fails with the usual message. Use production or localhost.

## 2. Connect Google

### Flow

1. The Connectors page shows a Google card with a "Connect Google" button. The button posts a form to `POST /api/connectors/google/connect` (same origin, signed in).
2. The route makes a random `state` (32 bytes) and a PKCE `code_verifier` (32 bytes). Google documents PKCE (S256) for installed apps; a web client sends it too, and the state check and the client secret protect the flow also if Google ignores it. It seals `{ userId, state, verifier, expiresAt }` with AES-GCM (the same key as the tokens, a different associated data label) and puts the result in the cookie `pdot_google_oauth`: httpOnly, Secure (not on localhost), SameSite=Lax, path `/api/connectors/google`, 10 minutes. Then it answers 303 to Google's authorization URL with `response_type=code`, `client_id`, `redirect_uri`, `scope`, `state`, `code_challenge` (S256), `access_type=offline` and `prompt=consent`. `prompt=consent` makes Google send a refresh token on every connect.
3. Google returns to `GET /api/connectors/google/callback`. The route always deletes the cookie. It checks, in this order: a valid session; a cookie that opens with the key and has not expired; the same user ID as the session; the same `state` (constant-time compare). Any failure redirects to `/connectors?google=error` and calls nothing.
4. The route exchanges the code at `https://oauth2.googleapis.com/token` with the verifier, the client ID and the client secret, with a 10-second timeout. Zod checks the answer: `access_token`, `expires_in`, `refresh_token`, `scope` and `id_token`.
5. The route reads `email` from the ID token. It does not check the signature: the token came straight from Google's token endpoint over TLS with the client secret, which [Google's OpenID documentation](https://developers.google.com/identity/openid-connect/openid-connect) allows. The address is used only to show "Connected as", never as an identifier.
6. The route keeps only the scopes from the list below that Google granted. The user can clear a box on Google's screen. If no data scope is left, the route stores nothing and shows "You did not allow access to Gmail or Calendar."
7. The route encrypts the refresh token and calls `save_connected_account` once. It drops the access token. Then it redirects to `/connectors?google=connected`.

The redirect URI is `${SITE_URL}/api/connectors/google/callback`. So Connect works on production and on localhost, not on a Preview (the cookie is on the Preview host).

### Disconnect

`POST /api/connectors/google/disconnect` (same origin). It reads the row, opens the token and posts it to `https://oauth2.googleapis.com/revoke` (10-second timeout). Then it deletes the row.

- Google answers 200: revoked. Google answers 400: an error, for example a token that is already invalid. In both cases the route deletes the row and answers "Disconnected."
- A timeout or a 5xx from Google: the route still deletes the row, because the user asked to stop. Without the ciphertext and the client secret together, nobody can use the token. The answer says: "Disconnected from P-Dot. Google did not confirm. You can also remove P-Dot at myaccount.google.com/permissions."
- The delete fails after a revoke: the row stays with a dead token. The next use gets `invalid_grant` and the card shows "Connect again". A second Disconnect revokes again (Google answers 400) and deletes. So a retry is safe.

### Token store

- **Encryption.** AES-256-GCM through WebCrypto (`crypto.subtle`), with a random 12-byte IV for each seal. The key is the Worker secret `GOOGLE_TOKEN_ENCRYPTION_KEY` (32 bytes, base64). The stored text is `v1.<iv>.<ciphertext>` in base64url. The associated data is `pdot:connected_accounts:<user id>:<provider>`, so a ciphertext copied to another user's row or to another provider does not open. `v1` lets a later change add a second key.
- **Access tokens** live in memory for one request only. The store refreshes one when it is missing or within 60 seconds of its expiry (`https://oauth2.googleapis.com/token`, `grant_type=refresh_token`, 10-second timeout, zod). They are never stored or logged.
- **A dead refresh token.** When Google answers `invalid_grant`, the store sets `status = 'needs_reconnect'`, only on the row that still has the same ciphertext (so a reconnect in another tab is not overwritten). The card then shows "Google access ended. Connect again." Apps in Testing get this after 7 days (see "Scopes").
- **Logs** hold the request ID, the route, the step and an error class. Never a token, a code, an address, a subject or any mail or event text.

### The table and who may read the ciphertext

Migration `20261030000000_google_connection.sql` adds `public.connected_accounts`:

| Column | Notes |
| --- | --- |
| `id`, `user_id`, `created_at`, `updated_at` | As in other tables. `user_id` cascades on account delete. |
| `provider` | `'google'` only today. Unique with `user_id`: one Google account for each user. |
| `account_email` | For "Connected as". 3 to 320 characters. |
| `scopes` | The granted data scopes. 1 to 10 items, each from the known list for the provider. |
| `token_ciphertext` | `v1.<iv>.<ciphertext>`, at most 4,096 characters. |
| `status` | `connected` or `needs_reconnect`. |

RLS: a user selects, inserts, updates and deletes only own rows. Grants: `select, insert, delete` and `update (account_email, scopes, token_ciphertext, status)` to `authenticated`, nothing to `anon`. `save_connected_account(provider, email, scopes, ciphertext)` is SECURITY INVOKER, so RLS and the grants apply. It inserts or replaces the caller's row for that provider in one statement and sets `status = 'connected'`. PostgREST's own upsert cannot do this, because it also writes `user_id` and `provider`, which have no update grant.

**The owner may read the own ciphertext row.** The other option was to hide the column from `authenticated` and read it through a SECURITY DEFINER function. That adds nothing here: the Worker reads the row with the user's own session, so any path that the Worker can use, the user can use too. The protection is the key, which only the Worker has, and the associated data, which binds a ciphertext to one user and one provider. A user who reads or writes the own ciphertext can only break the own connection. The app selects named columns. Only the token store selects `token_ciphertext`, and no API answer contains it (a test checks).

The table is generic, so a later integration adds a provider value and its scope list in a new migration.

### Scopes

Connect asks for these scopes and no others:

| Scope | Why | Google class |
| --- | --- | --- |
| `openid`, `email` | The address for "Connected as" (from the ID token). | Not sensitive |
| `https://www.googleapis.com/auth/gmail.readonly` | `gmailSearch` and `gmailRead` need search and the message body. `gmail.metadata` cannot search with a query or read a body. | **Restricted** |
| `https://www.googleapis.com/auth/gmail.send` | `gmailSend` only. It cannot read mail. | Sensitive |
| `https://www.googleapis.com/auth/calendar.events.owned` | `calendarListEvents` and `calendarCreateEvent` on the primary calendar. One scope covers both. Google lists it for `events.list` and `events.insert`, and the primary calendar is owned by its user. | Not stated on Google's page; Google gives reading calendar events as an example of a sensitive scope. Check the label in the Cloud console. |

Not chosen: `gmail.modify`, `gmail.compose` and full `mail.google.com` (they can change or delete mail); `gmail.metadata` (also restricted, and it cannot search or read a body); `calendar` (it can change calendars and sharing); `calendar.events` (events on all calendars, also calendars of other people that the user can edit). The database also accepts `calendar.events`, so the owner can change to it in the code without a migration if `calendar.events.owned` does not work for the primary calendar.

Sources: [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes), [Calendar scopes](https://developers.google.com/workspace/calendar/api/auth), [sensitive scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification).

What the classes mean for the owner:

- **Testing mode.** While the OAuth consent screen is External and in Testing, only listed test users can connect (at most 100), and Google does not ask for verification. An authorization by a test user expires 7 days after consent, and so does its refresh token, because these scopes are more than name, email and profile. Each test user must connect again each week. P-Dot shows "Connect again" when this happens ([Google](https://support.google.com/cloud/answer/15549945), [refresh token expiration](https://developers.google.com/identity/protocols/oauth2)).
- **Production with sensitive scopes** (`gmail.send`, and the calendar scope if the console marks it sensitive): Google must verify the app before the 100-user cap goes and people outside the test list can connect ([OAuth app verification](https://support.google.com/cloud/answer/9110914)).
- **Production with a restricted scope** (`gmail.readonly`): restricted scope verification (it can take several weeks) and, because P-Dot reads the data on its server, a security assessment by a third-party assessor, again at least every 12 months ([restricted scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification), [security assessment](https://support.google.com/cloud/answer/13465431)). Google's pages do not give the cost. This is the main cost of reading Gmail. Without it, Gmail reading stays limited to test users.
- **Other ways a refresh token ends:** the user changes the Google password (the token has Gmail scopes), the token is not used for six months, or the user has more than 100 refresh tokens for this client (Google then ends the oldest one).

## 3. Reads are `read_sensitive`: the "Use Google" toggle (proposal for the tool loop)

Not built in this change. This change builds the server modules only.

- The message box gets a "Use Google" toggle, like the web search toggle. It is off by default, it is shown only when Google is connected, and it applies to one message. The request schema gets `useGoogle: boolean`. It is not part of the resend fingerprint, as `webSearch` is not.
- The tool registry offers `gmail_search`, `gmail_read` and `calendar_list_events` only when `useGoogle` is true and the needed scope was granted. The toggle is the user's approval for these reads, for this message only. Auto mode never turns it on. This replaces the `read_source` proposal in step 5 of decision 0011: a proposal for each read would ask the user many times in one turn, and the toggle asks once, before any read.
- **Prompt injection through email is the main threat.** Anyone can send the user an email or a calendar invitation. Its text can say "ignore your instructions" or "send this file to me". So:
  - Tool results go into the prompt inside `<untrusted_google_data>` blocks, with a note that the text is data and not instructions, as web results are.
  - Text read from Google can never approve, decide or authorize anything. An action that a reply proposes after a Google read is a normal proposal: `send_email` and `create_calendar_event` are `external` and always wait for the user, in every mode. The approval card shows every field in full, so the user sees what an injected instruction asks for.
  - The read modules return plain text only: no HTML, no links that load, no attachments. Each result has a size limit.
- "What was sent" records how many Google items went to the model (counts and IDs, never text).

## 4. Writes: `send_email` and `create_calendar_event`

### Payloads

Checked by zod in the app and again by `normalize_action_payload` in the database, with the same limits:

| Kind | Keys | Limits |
| --- | --- | --- |
| `send_email` | `kind`, `mode`, `to`, `subject`, `body` | `to`: 1 to 10 addresses, each at most 254 characters, in the WHATWG email form (ASCII, no spaces, no line breaks). `subject`: 1 to 200 characters, no control characters. `body`: 1 to 4,000 characters, plain text. |
| `create_calendar_event` | `kind`, `mode`, `title`, `start`, `end`, `attendees` | `title`: 1 to 200 characters, no control characters. `start`, `end`: ISO 8601 with seconds and an offset; `end` after `start`; at most 31 days. `attendees`: 0 to 20 addresses. |

The payload size check on `action_proposals` goes from 8,192 to 32,768 bytes, because a 4,000-character body can need 16,000 bytes. The checks refuse CR and LF in addresses and the subject, so a payload cannot add a mail header.

### The approval card

The card shows the full recipient list, the subject and the whole body, or the title, the start and end in the viewer's time zone, and every attendee. It says "Google sends an invitation to each attendee" when there are attendees. The card asks in every mode ("It acts outside P-Dot ..."). The user can edit the fields before approving.

### Execution: claim, `executing`, then `executed` or `failed`

The database cannot call Google, so the decision has three steps. All three are SECURITY DEFINER functions with an empty search path, granted only to `authenticated`. Each one reads `auth.uid()` and gives another user's proposal the same `not_found` answer as a missing one.

1. **Claim.** `decide_action_proposal(id, 'approve', payload)` checks the payload and, for an external kind, moves the row from `proposed` to `executing` in one update. It stores a new `execution_claim_id` and `execution_started_at`. It answers `executing`. Only one decision can make this move, so only one request holds the claim. Reject works as before.
2. **Call Google.** The Worker (the decision route) loads the token and calls Gmail or Calendar with a 15-second timeout.
3. **Finish.** `finish_external_action(id, claim_id, succeeded, result)` stores `executed` with `{ messageId }` or `{ eventId }`, or `failed` with `{ error: "execution_failed", reason }`. It accepts only the current claim of an `executing` row, and only a result of the right shape. The reasons are a fixed list: `not_connected`, `needs_reconnect`, `scope_missing`, `google_rejected`.

The Worker stores `failed` only when Google did not act: it did not call Google (no connection, a dead token, a missing scope), or Google answered 4xx. A timeout, a network error or a 5xx after the request left the Worker means "outcome unknown". Then the Worker does not finish, and the row stays `executing`.

The status rules in the `check_action_proposal` trigger: `proposed` to `executing` and `executing` to `executed` or `failed`, for the two external kinds only. An external kind never uses `approved`. An `executing` row cannot change its payload, kind or decision time. The log trigger writes `approved` when a row enters `executing`, and `executed` or `failed` after. The detail holds the kind, the mode and the Gmail message ID or the Calendar event ID, never an address, a subject or a body. The action log is still written only by the database (decision 0009).

### A retry never sends twice

- A second approval of the same proposal gets `already_decided`, also while it is `executing`.
- A finish with an old claim gets `stale_claim` and changes nothing.
- **Calendar** is idempotent at Google. The event ID is the proposal ID without dashes: 32 characters from `0-9a-f`, inside the base32hex set (`a-v`, `0-9`, 5 to 1,024 characters) that `events.insert` allows. A second insert with that ID gets 409 `duplicate` ([Calendar errors](https://developers.google.com/workspace/calendar/api/guides/errors)), and the Worker stores `executed` with that ID. Google says it cannot promise to find every collision at insert time, so this is strong protection, not a proof.
- **Gmail** has no idempotency key, and Gmail can replace a `Message-ID` that the client sets. So P-Dot never sends a `send_email` proposal again by itself, also after a timeout.

### Recovery of `executing` (AGENTS.md rule)

The lease is 120 seconds (`EXTERNAL_ACTION_LEASE_SECONDS`), much more than the longest Google call (10 seconds for a token refresh plus 15 seconds for the call).

- `reclaim_external_action(id, lease_seconds)`: for a row that is `executing` and older than the lease.
  - `create_calendar_event`: a new claim, `claimed`. The Worker inserts again with the same event ID: 409 means the first try worked. So this kind always leaves `executing`. The screen calls it when the user opens a card that is stuck, and the decision route calls it for a second approval click.
  - `send_email`: `outcome_unknown`, and no claim. P-Dot never sends it again.
  - A row inside the lease gets `busy`.
- `settle_unknown_external_action(id, lease_seconds, sent)`: only for a `send_email` row that is `executing` and older than the lease. The card says: "P-Dot does not know if this email was sent. Check your Sent folder." The user answers. `sent = true` stores `executed` with `{ userConfirmed: true }`; `false` stores `failed` with the reason `not_sent`. The function does not set the trust marker, so `decided_by_function` and the log row's `verified` are false, and the screens show "Marked done" ([0009](0009-memory-documents-actions.md)). To send again, the user asks P-Dot again, which makes a new proposal.
- If the user never answers, the row stays `executing` and shows the same question. It never runs again.

### What "verified" means for an external action

For the internal kinds, `decided_by_function = true` means the database ran the action. For an external kind it means the claim and the finish went through the functions with a matching claim. The Gmail or Calendar ID in the result is what the Worker reported with the user's session. A user who calls `finish_external_action` directly with the own claim could store a false ID for the own action. Without a server secret this cannot be prevented ([0009](0009-memory-documents-actions.md), "Context records stay user-written"). It affects only that user's own record.

## 5. Google API modules (server only)

`src/server/google/`: plain `fetch` with an `AbortSignal` timeout, zod for every answer, no `googleapis` package (too large for a Worker). Each function takes a token source and a `fetch`, so the tests use fakes.

| Function | Google call | Bound |
| --- | --- | --- |
| `gmailSearch(query, max)` | `messages.list`, then `messages.get` with `format=metadata` for each | At most 10 results. From, To, Subject, Date and the snippet, each cut to a limit. |
| `gmailRead(id)` | `messages.get` with `format=full` | Plain text only: the `text/plain` part, or the `text/html` part with tags removed. At most 8,000 characters, with a flag when cut. |
| `calendarListEvents(from, to, max)` | `events.list` on `primary`, `singleEvents=true`, `orderBy=startTime` | At most 25 events and 31 days. Title, start, end, location, attendee count. |
| `gmailSend(payload)` | `messages.send` with a base64url RFC 2822 message | Headers built only from the checked payload. A non-ASCII subject uses RFC 2047. |
| `calendarCreateEvent(payload, eventId)` | `events.insert` on `primary` with the event ID; `sendUpdates` is always sent: `all` when there are attendees, else `none` | 409 means "already created". |

Timeouts: 10 seconds for token calls and reads, 15 seconds for a send or an insert. Errors map to classes: `unauthorized` (401, or a dead token), `forbidden` (403, for example a missing scope), `rejected` (other 4xx), `unavailable` (429, 5xx), `timeout`, `bad_response` (the answer does not match the schema). Retries: none in this change. The tool loop can retry a read; a write is never retried except through the calendar reclaim.

## 6. Configuration

| Name | Kind | Notes |
| --- | --- | --- |
| `GOOGLE_OAUTH_CLIENT_ID` | Worker secret (not secret by nature) | On the allow list in `scripts/worker-env-rules.mjs`, because it is public. |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Worker secret | Never on the allow list. |
| `GOOGLE_TOKEN_ENCRYPTION_KEY` | Worker secret | 32 random bytes, base64 (`openssl rand -base64 32`). Never on the allow list. Losing it means every user must connect again. |

`getGoogleConfig()` in `src/server/config.ts` reads them per call. All three missing: `not_set_up`. Some missing or a bad key: `not_set_up` too, and the server logs `google_config_invalid` with the names only. Sign-in with Google needs none of them: it uses the Supabase provider settings. `GET /api/health` adds `google: true|false`.

## 7. Deploy order (expand, then code)

1. **PR G1, database (expand), branch `om/google-expand-db`.** This record, migration `20261030000000_google_connection.sql`, the gate tests in both grant modes, the hash line, the DEPLOYMENT.md steps and a CHANGELOG entry. The code on main does not use the new objects, and its reads and decisions still work (the gate runs main's repositories on the new schema).
   - Check 1: the owner confirms in the Supabase dashboard that `20261030000000_google_connection` is in the migration history and that these exist: the table `connected_accounts` with RLS on and four policies; the columns `execution_claim_id` and `execution_started_at` on `action_proposals`; the functions `save_connected_account`, `finish_external_action`, `reclaim_external_action` and `settle_unknown_external_action`; and the new definitions of `decide_action_proposal`, `normalize_action_payload`, `check_action_proposal` and `log_proposal_change`.
2. **PR G2, code, branch `om/google-connect`.** Merge only after check 1. Before the migration, Connect fails at `save_connected_account` (404 from PostgREST) and stores nothing; the screen shows the error state. Do not use its Preview before check 1, because Previews use the production database.

There is no contract step. Each step merges and deploys on its own.

Rollback: a Worker version from before G2 ignores the new table and kinds. A proposal of a new kind that exists then is left out of its lists (the parser skips it), and an approval of one answers 500. Never undo the migration by hand.

## Risks

- **Prompt injection through email** (section 3). The main threat.
- **Account pre-registration while "Confirm email" is off.** A person can sign up with a password and another person's address. Supabase treats that sign-up as confirmed. When the real owner of the address later uses "Continue with Google", Supabase can link the Google identity to that account, and the first person still knows its password. Before anyone other than the owner's test users signs in with Google, turn "Confirm email" back on (it needs custom SMTP for real users, DEPLOYMENT.md step 6). Supabase's page does not show this exact case, so the owner checks it with two test accounts.
- **The key.** If `GOOGLE_TOKEN_ENCRYPTION_KEY` leaks together with the database rows, every stored refresh token is open. Rotate: set a new key and ask every user to connect again (a `v2` format would allow a gradual change later).
- **Testing mode** ends access every 7 days, and the app is limited to 100 test users.
- **An email with an unknown outcome** waits for the user's answer. P-Dot does not search the Sent folder for it.

## Limits

- One Google account for each user. A reconnect replaces the row. Google keeps the old refresh token until it is revoked or replaced; P-Dot does not revoke it on reconnect.
- Account deletion deletes the row but does not revoke the token at Google.
- Calendar: the primary calendar only. Gmail: no attachments, no HTML bodies sent, no reply threading.
- The gate has one connection. It checks a second claim after the first one, not two live sessions; the row lock in each function is what serializes them.
