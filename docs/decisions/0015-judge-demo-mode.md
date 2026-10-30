# 0015: Try P-Dot without an account

- Status: Proposed (2026-10-30). High-level and low-level design.
- Related: [0001 Supabase](0001-supabase-auth-and-database.md), [0006 spend guard](0006-global-spend-guard.md), [0009 memory and actions](0009-memory-documents-actions.md), [0011 approval modes](0011-approval-modes.md), [0013 tools](0013-ai-tools-and-scope.md).

## Goal

Hackathon judges must try P-Dot with no friction. Today a judge must create an account first. This change adds one button, "Try P-Dot now, no account", on the landing page and the login page. The button makes a Supabase anonymous user and opens `/chat`.

## Flows

1. **Start a trial.** The judge clicks the button. The browser calls `supabase.auth.signInAnonymously()` with the publishable key. Supabase sets the session cookies. The browser goes to `/chat`. If the browser already has a session, the button goes to `/chat` and makes no new user.
2. **Use the app.** A trial user is a real Supabase user. `auth.uid()` works, so RLS, the chat quota and the per-user spend cap apply to the trial user as to any user. The JWT has `is_anonymous: true` and no email.
3. **See that it is a trial.** Every workspace page shows a slim banner: "You are trying P-Dot without an account." with a link to create an account. The header shows "Trial" where it shows the email for an account.
4. **First run.** An empty chat shows 4 example prompts: web search with sources, a memory, a reminder, and "Think harder" on a plan. A click fills the message box and sets the search or effort switch. It does not send.
5. **Create an account.** The link opens `/signup`. Sign-up makes a new, separate account. The trial chats do not move to it. The sign-up page says this to a trial user.
6. **Blocked for a trial.** A trial user cannot set a password (no email) and cannot connect outside accounts. The server refuses both. The UI shows "Create an account to connect".

## Why the browser, not a server action

The request asked for a server action. Supabase limits anonymous sign-ins to 30 each hour **for each IP address**. A server action calls Supabase from the Cloudflare Worker, so Supabase sees the Worker's IP, and all judges together would share one limit of 30 each hour. Supabase can read the user's IP from the `Sb-Forwarded-For` header, but only with the secret key, which this app must never hold (decision 0001). So the browser makes the call, and each judge's own IP counts. The publishable key is already public. This adds no new trust.

## Trust boundaries

- **Browser to Supabase Auth:** the browser sends only the publishable key. Supabase decides if anonymous sign-ins are on and applies its IP limit.
- **Browser to the Worker:** unchanged. Every page and API route verifies the JWT with `getClaims()`. The server reads `is_anonymous` from the verified claims only, never from the client.
- **Database:** unchanged. RLS uses `auth.uid()`. Anonymous users have the `authenticated` role. No policy reads the email. No migration.
- **Paid providers:** unchanged. The per-user quota and spend cap apply to each trial user. The global daily and total caps (decision 0006) cap the total cost of all trial users together.

## Data

- New rows only in `auth.users` (one for each trial, `is_anonymous = true`) and the usual app tables under that user ID.
- Nothing new is stored by the app. No new table, column or setting.
- Old trial users stay until the owner deletes them. DEPLOYMENT.md gives the SQL.

## Risks

| Risk | Effect | Limit |
| --- | --- | --- |
| Anonymous sign-ins are off in Supabase | The button cannot start a trial | The button shows "Trying P-Dot without an account is off right now. Create an account or sign in." Nothing else changes. The owner turns the setting on (DEPLOYMENT.md). |
| Many trial users from one person | Each trial user has its own per-user cap, so one person can use the global daily cap ($1.00) faster | Supabase limits 30 trials each hour for each IP. The global daily and total caps hold the cost. The effect is an outage until the next UTC day, not a charge. The owner can lower the IP limit or turn on CAPTCHA. |
| A trial user expects to keep the chats | Sign-up makes a new account | The banner and the sign-up page say that trial chats do not move. Account conversion is out of scope (below). |
| Code that assumes an email | Wrong text or a crash | The email claim of a trial user is an empty string or missing. `getAuthContext` returns `null` for both. Every use of the email is checked. |
| A signed-in user is sent away from `/login` and `/signup` | A trial user could not reach sign-up | The proxy lets a trial user open `/login` and `/signup`. |
| Pull request #25 adds Google connect | A trial user could connect Google | The route wrapper gets a `requireAccount` option that answers 403 `account_required`. #25 must use it on its connect routes. |

## Out of scope

- **Converting a trial to a permanent account.** Supabase needs manual identity linking on, then an email change that the user confirms by email, then a password. The hosted project sends email only to team members (DEPLOYMENT.md, step 6). So this is not simple or safe today.
- CAPTCHA, a separate spend cap for trial users, and automatic clean-up of old trial users.

## Low-level design

### Files and functions

| File | Change |
| --- | --- |
| `src/lib/auth-identity.ts` (new) | `readIdentity(claims)` returns `{ userId, email, isAnonymous }` or `null`. `email` is `null` when the claim is missing, not a string or empty. `isAnonymous` is `claims.is_anonymous === true`. A token without the claim is an account. The server session and the proxy both use it. |
| `src/server/auth/session.ts` | `AuthContext` gets `isAnonymous?: boolean`, set by `getAuthContext` from `readIdentity`. New `hasAccount(auth)`: `true` only when `isAnonymous === false`. A context made without the field (a test fake) has no account, so the check fails closed. |
| `src/server/http/route.ts` | `withAuthenticatedRoute` option `requireAccount`. When it is set and `hasAccount` is false, the route answers 403 `account_required` ("Create an account to connect other accounts.") before the handler runs. |
| `src/types/api.ts` | `ApiErrorCode` gets `account_required`. |
| `src/server/auth/proxy-session.ts` | The redirect away from `/login`, `/signup` and `/forgot-password` applies only to an account, not to a trial user. |
| `src/features/auth/errors.ts` (new) | `isRateLimit` and `isOutage` move here from `actions.ts` (a `"use server"` file can export only async functions). New `trialErrorMessage(error)`. |
| `src/features/auth/TryWithoutAccount.tsx` (new) | Client button. On click it loads `@supabase/ssr` on demand, makes a browser client with the publishable key, and calls `getSession()`. With a session it goes to `/chat`. Otherwise it calls `signInAnonymously()`, then `window.location.assign("/chat")`. A full page load makes the server read the new cookies. |
| `src/features/auth/actions.ts` | `updatePasswordAction` refuses a trial user: "A trial has no password. Create an account first." |
| `src/app/page.tsx`, `src/app/(auth)/login/page.tsx` | Show the button to signed-out visitors. The login page shows it under the form after an "or" line. |
| `src/app/(auth)/signup/page.tsx` | For a trial user: "Your trial chats do not move to the new account." |
| `src/app/(workspace)/layout.tsx`, `src/components/layout/WorkspaceHeader.tsx`, `src/components/layout/TrialBanner.tsx` (new) | The banner under the header for a trial user. The header shows "Trial" in place of the email. |
| `src/app/(workspace)/settings/page.tsx` | A trial user sees "You are trying P-Dot without an account", a "Create an account" link and an "End trial" button, and no "Change password". |
| `src/app/(workspace)/connectors/page.tsx` | A trial user sees "Create an account to connect other accounts." in the planned accounts section. |
| `src/features/chat/starter-prompts.ts`, `src/features/chat/StarterPrompts.tsx` (new), `ChatWorkspace.tsx` | 4 prompt chips for each mode in the empty chat. A click fills the draft and sets the web search and effort switches. It never sends. |
| `supabase/config.toml` | `enable_anonymous_sign_ins = true` for the local stack only. The hosted setting is the owner's (DEPLOYMENT.md). |
| `docs/DEPLOYMENT.md`, `CHANGELOG.md` | The owner step, the abuse limits and the clean-up SQL. |

### Button states

| State | Shown |
| --- | --- |
| Idle | "Try P-Dot now, no account" |
| Pending | "Starting your trial…", button disabled |
| Already signed in | Goes to `/chat`, no new user |
| Error | The message under the button in `role="alert"`, button enabled again |

### Error cases

| Supabase answer | Message |
| --- | --- |
| `anonymous_provider_disabled` (HTTP 422) | "Trying P-Dot without an account is off right now. Create an account or sign in." |
| HTTP 429 or a code that starts with `over_` | "Too many trials from this network. Wait a few minutes, or create an account." |
| `captcha_failed` | Same as off: this page sends no CAPTCHA token. |
| Network error, HTTP 5xx or no status | "The account service is unavailable right now. Please try again later." |
| No Supabase settings in the build | Same as unavailable. |
| Any other error | "We could not start a trial. Try again, or create an account." |

The messages never include the Supabase error text.

### Prompt chips

| Shows off | Personal | Work | Sets |
| --- | --- | --- | --- |
| Web search with sources | What are the top news stories today? Give me the sources. | What is new in the latest Next.js release? Give me the sources. | Web search on |
| Memory | Remember that I prefer short answers. | Remember that I prefer short answers. | Nothing |
| Reminder or task | Remind me to call the dentist tomorrow at 10 am. | Remind me to send the weekly report on Friday at 4 pm. | Nothing |
| Think harder | Plan a 3-day weekend in Lisbon on a small budget. | Plan my week to ship a small feature by Friday. | Effort "Think harder" |

The wording works before and after pull request #24. Before #24 the model answers in text. After #24 the memory and reminder chips make a "Remember this?" card or an approval card.

### Tests

- `readIdentity`: an anonymous token with `email: ""`, an anonymous token with no email, an account, a token without `is_anonymous`, a token without `sub`.
- `trialErrorMessage`: each row of the error table, built as the real `AuthApiError` and `AuthRetryableFetchError` objects from `@supabase/supabase-js`.
- `withAuthenticatedRoute` with `requireAccount`: a trial user gets 403 `account_required` and the handler does not run; an account runs the handler; a context without `isAnonymous` gets 403; a route without the option lets a trial user through.
- Proxy: a trial user stays on `/signup` and `/login`; an account is sent to `/chat`; a signed-out visitor to `/chat` goes to `/login`.
- `updatePasswordAction`: a trial user is refused before `updateUser` runs.
- Prompt chips: 4 for each mode, one with web search, one with "Think harder", each shorter than the message limit.
