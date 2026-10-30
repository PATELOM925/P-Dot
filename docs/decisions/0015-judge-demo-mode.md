# 0015: Try P-Dot without an account

- Status: Proposed (2026-10-30). High-level and low-level design. Review round 1 findings applied.
- Related: [0001 Supabase](0001-supabase-auth-and-database.md), [0006 spend guard](0006-global-spend-guard.md), [0009 memory and actions](0009-memory-documents-actions.md), [0011 approval modes](0011-approval-modes.md), [0013 tools](0013-ai-tools-and-scope.md).

## Goal

Hackathon judges must try P-Dot with no friction. Today a judge must create an account first. This change adds one button, "Try P-Dot now, no account", on the landing page and the login page. The button makes a Supabase anonymous user and opens `/chat`. The trial is for the judging period. The owner turns it off after judging and deletes old trial users by **2027-01-31** (DEPLOYMENT.md).

## Flows

1. **Start a trial.** The judge clicks the button. The browser makes a client with `createBrowserClient` from `@supabase/ssr`, with the same project URL and publishable key as the server. This client keeps the session in P-Dot cookies through `document.cookie`, with the same names, encoding and chunks that the server reads. It does not use local storage. The browser waits until `signInAnonymously()` returns and the session is written. Then it does a full page load of `/chat` (`window.location.assign`), not a router push. The proxy and `createSupabaseServerClient` read and refresh the same cookies. If the browser already has a valid session (checked with `getUser()`, which asks the Auth server), the button goes to `/chat` and makes no new user. The button is disabled from the first click until the page changes, so a double click makes one user.
2. **Use the app.** A trial user is a real Supabase user. `auth.uid()` works, so RLS applies as to any user. The JWT has `is_anonymous: true` and an empty or missing email. The server reads the flag only from the verified top-level `is_anonymous` claim, never from the email or user metadata.
3. **Lower per-user limits.** A trial user gets lower per-user limits than an account: 20 chat requests in each window (accounts: 30), $0.15 of Nebius each UTC day (accounts: $0.25) and 5 Tavily credits each UTC day (accounts: 10). Each is the lower of the account value and the trial value. They apply to chat, search and embeddings. The global caps and the worst-case hold do not change. These limits are for fair use. They do not stop abuse, because a person can start many trials.
4. **See that it is a trial.** Every workspace page shows a slim banner: "Trial without an account. When you end the trial, you cannot open these chats again. Create an account" (on phones: "Trial. Chats end when the trial ends. Create an account"). It never says that sign-up keeps the trial chats. The header shows "Trial" (from the verified flag) where it shows the email for an account.
5. **First run.** An empty chat shows 4 example prompts: web search with sources, a memory, a reminder, and "Think harder" on a plan. A click fills the message box and sets the search or effort switch. It does not send.
6. **Create an account.** The link opens `/signup`. Sign-up makes a new, separate identity and replaces the trial session. Sign-in with a password also replaces the trial session. The trial chats do not move. The banner and the sign-up page say this before the user leaves the trial.
7. **Blocked for a trial.** A trial user cannot set a password and cannot do anything that reaches an outside account. The server refuses both before any effect.

## Why the browser, not a server action

The request asked for a server action. Supabase limits anonymous sign-ins to 30 each hour **for each public IP address** (a default that the owner can change). A server action calls Supabase from the Cloudflare Worker, so Supabase sees the Worker's egress IP, and many judges could share one limit. Supabase can read the user's IP from the `Sb-Forwarded-For` header, but only with the secret key, which this app must never hold (decision 0001). So the browser makes the call, and each visitor's own public IP counts. The publishable key is already public. This adds no new trust. Review round 1 accepted this.

## The account rule for outside effects

- A trial user may use everything inside P-Dot: chat, web search, memories, documents, tasks, reminders and approvals.
- A trial user may not do anything that needs a permanent identity or reaches an outside account: set a password, connect an account (consent start and callback), read from a connected account, or send or change anything in one.
- The server enforces the rule at the boundary of each outside effect. It refuses before it writes, redirects to consent, exchanges a token or calls an outside service:
  - API routes use `withAuthenticatedRoute(..., { requireAccount: true })`. A missing or invalid session is still 401 `unauthorized`. A valid trial session is 403 `account_required`.
  - Code that is not a route (a tool, an action executor, a background job) calls `hasAccount(auth)` before the outside effect and refuses when it is false.
  - The password server action has its own check.
- A shared route that also does inside work (chat, the action decision route) is not blocked as a whole. Only the outside effect inside it is refused.
- The account rule and approval (decision 0011) are separate. An account does not approve an action, and an approval does not let a trial user run an outside action.
- Main has no outside connector today. Pull request #25 (Google) adds its own check on its routes. Before #25 and this change are used together, every #25 outside path must refuse a trial user, with this option or with `hasAccount`.

## Trust boundaries

- **Browser to Supabase Auth:** the browser sends only the publishable key. Supabase decides if anonymous sign-ins are on and applies its IP limit.
- **Browser to the Worker:** unchanged. Every page and API route verifies the JWT with `getClaims()`. The server reads `is_anonymous` from the verified claims only.
- **Database:** unchanged. RLS and every RPC use `auth.uid()`, not the email. Anonymous users have the `authenticated` role. No migration.
- **Paid providers:** see "Abuse and cost".

## Abuse and cost

| Case | What happens | Recovery |
| --- | --- | --- |
| Real use through the app by many trials | Each trial has its own per-user cap. Together they can use up the global daily cap ($1.00). Then chat refuses every user until the next UTC day. Over many days they can use up the all-time cap ($20.00). | Daily cap: wait for the next UTC day, or turn the trial off. All-time cap: chat stays refused until the owner acts. The owner adds credit and resets the total counter (decision 0006), or raises `NEBIUS_TOTAL_CAP_USD`. |
| Direct RPC calls | Any signed-in user, also a trial user, can call `reserve_provider_spend` with the public key and never settle (decision 0006). This uses up the counters with no provider call and no charge. Many trials can use up the daily cap and, over time, the all-time cap. | The same as above. Also turn the trial off, delete the trial users and reset the counters in the SQL editor. |
| Many trials from one place | 30 new trials each hour for each public IP (configurable). Judges on one venue network share it. A person with many IPs gets more. The limit does not limit what a trial can write. | The owner can change the limit in Supabase, or turn the trial off. |

In each case the owner's money stays safe, because the global caps hold every paid call through the app. The cost of abuse is loss of service, not a charge. This is accepted for a short, supervised demo with an end date.

## Data and retention

- New rows only in `auth.users` (one for each trial, `is_anonymous = true`) and the usual app tables under that user ID. No new table, column or setting.
- Sign-out, or a lost browser cookie, ends access to a trial. It does not delete the data. A copied token stays valid until it expires (decision 0001).
- The owner deletes trial users older than a cutoff by 2027-01-31. A delete of a user deletes that user's app rows by cascade. The global spend counters stay. Backups keep copies until they expire. The runbook is in DEPLOYMENT.md, and `tests/integration/trial-cleanup.test.ts` runs its SQL against every migration.

## Risks

| Risk | Effect | Limit |
| --- | --- | --- |
| Anonymous sign-ins are off in Supabase | The button cannot start a trial | The button says that the trial is off. Nothing else changes. The owner turns the setting on (DEPLOYMENT.md). |
| The per-IP limit is reached | The button cannot start a trial | The button says "Too many trials from this network", apart from the "off" message. |
| A trial user expects to keep the chats | Sign-up makes a new account | The banner and the sign-up page say that trial chats do not move. Account conversion is out of scope. |
| Code that assumes an email | Wrong text | `getAuthContext` returns `email: null` for an empty or missing email claim, and keeps the context valid. |
| A signed-in user is sent away from `/login` and `/signup` | A trial user could not reach sign-up | The proxy lets a trial user open them. An account is still sent to `/chat`. |

## Out of scope

- **Converting a trial to a permanent account.** Supabase needs manual identity linking on, then an email change that the user confirms by email, then a password. The hosted project sends email only to team members (DEPLOYMENT.md, step 6). So this is not simple or safe today.
- CAPTCHA (the button sends no token, so CAPTCHA would block every trial) and automatic clean-up of old trial users.

## Low-level design

### Files and functions

| File | Change |
| --- | --- |
| `src/lib/auth-identity.ts` (new) | `readIdentity(claims)` returns `{ userId, email, isAnonymous }` or `null`. `email` is `null` when the claim is missing, not a string or empty. `isAnonymous` is `claims.is_anonymous === true`. A token without the claim is an account. The server session, the proxy and the password action use it. `hasAccount(auth)` is `true` only when `isAnonymous === false`, so a context without the field (a test fake) fails closed. |
| `src/server/auth/session.ts` | `AuthContext` gets `isAnonymous?: boolean`, set by `getAuthContext` from `readIdentity`. |
| `src/server/http/route.ts`, `responses.ts` | `withAuthenticatedRoute` option `requireAccount`. When it is set and `hasAccount` is false, the route answers 403 `account_required` ("Create an account to connect other accounts.") before the handler runs. No session is still 401. |
| `src/types/api.ts` | `ApiErrorCode` gets `account_required`. |
| `src/server/trial-limits.ts` (new) | `limitsFor(auth, config)` returns the account limits, or the lower trial limits when `hasAccount` is false. `createAssistantDeps` and `createEmbedderForRequest` use it for the quota and both spend guards. |
| `src/server/auth/proxy-session.ts` | The redirect away from `/login`, `/signup` and `/forgot-password` applies only to an account, not to a trial user. |
| `src/features/auth/errors.ts` (new) | `isRateLimit` and `isOutage` move here from `actions.ts` (a `"use server"` file can export only async functions). New `trialErrorMessage(error)`. |
| `src/features/auth/TryWithoutAccount.tsx` (new) | Client button. On click it loads `@supabase/ssr` on demand and makes a cookie-backed browser client with the publishable key. It calls `getUser()`. With a valid user it goes to `/chat`. An outage answer stops with the unavailable message. Otherwise it awaits `signInAnonymously()`, then `window.location.assign("/chat")`. The button stays disabled after a success, so a second click cannot make a second user. |
| `src/features/auth/actions.ts` | `updatePasswordAction` refuses a trial user before `updateUser`: "A trial has no password. Create an account first." |
| `src/app/page.tsx`, `src/app/(auth)/login/page.tsx` | Show the button to signed-out visitors. The login page shows it under the form after an "or" line. |
| `src/app/(auth)/signup/page.tsx` | For a trial user: "Your trial chats do not move to the new account." |
| `src/app/(workspace)/layout.tsx`, `src/components/layout/WorkspaceHeader.tsx`, `src/components/layout/TrialBanner.tsx` (new) | The banner under the header for a trial user. The header shows "Trial" in place of the email, and "End trial" in place of "Sign out". |
| `src/app/(workspace)/settings/page.tsx` | A trial user sees that a trial has no email and no password, a "Create an account" link and an "End trial" button, and no "Change password". |
| `src/app/(workspace)/connectors/page.tsx` | A trial user sees "Create an account to connect other accounts." in the planned accounts section. |
| `src/features/chat/starter-prompts.ts`, `src/features/chat/StarterPrompts.tsx` (new), `ChatWorkspace.tsx` | 4 prompt chips for each mode in the empty chat. A click fills the draft and sets the web search and effort switches. It never sends. |
| `supabase/config.toml` | `enable_anonymous_sign_ins = true` for the local stack only. The hosted setting is the owner's (DEPLOYMENT.md). |
| `docs/DEPLOYMENT.md`, `docs/PRD.md`, `docs/ARCHITECTURE.md`, `CHANGELOG.md` | The owner step, the abuse limits, the clean-up runbook and the scope line. |

### Button states

| State | Shown |
| --- | --- |
| Idle | "Try P-Dot now, no account" |
| Pending | "Starting your trial…", button disabled |
| Already signed in | Goes to `/chat`, no new user |
| Success | Button stays disabled until the page changes |
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
- Trial limits: `limitsFor` for an account, a trial and a context without the flag. The trial caps reach `consume_chat_quota` and `reserve_provider_spend` for chat, search and embeddings. The global caps stay.
- Clean-up SQL: on every migration in PGlite, with memories, documents, a conversation and executed task, reminder and memory proposals. The delete removes only the old trial user and all its rows. It keeps the new trial user, the account and the spend counters.
- Prompt chips: 4 for each mode, one with web search, one with "Think harder", each shorter than the message limit.
- Browser proof (Playwright against `npm run dev` with a local stand-in for Supabase Auth): the first load of `/chat`, a reload and a token refresh keep the trial session.
