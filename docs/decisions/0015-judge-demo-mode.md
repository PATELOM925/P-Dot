# 0015: Try P-Dot without an account

- Status: Proposed (2026-10-30). High-level design. The low-level design follows in this record.
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
