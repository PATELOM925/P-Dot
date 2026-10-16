# 0005 — Assistant hub: connectors, workflows, daily brief (proposal)

- Status: Partly implemented (2026-10-16). Built: Personal/Work modes, to-do list, conversation rename, browser dictation, the new landing page, and preview-only Workflows and Connectors pages. Not built and still open: real connectors, workflows/scheduler, approvals, daily brief, Telegram/WhatsApp/phone. The PRD has not been amended.
- Source: design review comment on the "P-Dot Frontend Design" canvas (2026-10-16).

## Request

Add, beside chat: connectors (Gmail, GitHub, Vercel, WhatsApp, phone calls and appointment booking, Telegram delivery), workflows, a daily brief and to-do list, and separate Personal and Work views, in a neutral palette suited to adults and teenagers. Mockups: boards "Today: Personal", "Today: Work", "Workflows" and "Connectors" on the canvas.

## Conflicts with the current PRD

The PRD (section 8) puts these out of scope for the MVP: autonomous actions, email sending, calendar edits, other external account mutations, background reminders and scheduled jobs. `AGENTS.md` also requires explicit user confirmation before any consequential external action.

## Open decisions before any implementation

- Scope: move this into a post-MVP phase, or amend the PRD.
- Connector security: OAuth token storage (encrypted, per user), least-privilege scopes, read-only first, revocation, audit log. MCP servers and retrieved content are untrusted input.
- Approval model: every send, booking, call or delete shows what will happen and waits for the user. The mockups assume this.
- Scheduling: workflows and the morning brief need a scheduler (for example Cloudflare Cron Triggers plus a queue); the current app has none.
- Channels: Telegram bot is the simplest delivery target; WhatsApp needs business API approval and costs; phone calls need a telephony provider, consent, and regional legal review.
- Minors: if teenagers are an audience, age limits, parental consent and data-protection rules (for example COPPA/GDPR-K) must be decided before connecting personal accounts.
- Palette: resolved. All boards and the app use the neutral scheme (stone grey, calm blue, sage for success, DM Sans).

## Implementation notes (2026-10-16)

- Modes: `conversations.mode` and `tasks.mode` (`personal` | `work`) with RLS; the selected mode is a view cookie (`pdot_mode`), not an authorization control. The assistant is told which topics belong to the mode, but this is a prompt instruction, so it is a guide rather than a guarantee.
- Dictation uses the browser's Web Speech API (English). Audio may be processed by the browser vendor; P-Dot servers receive only the text the user sends. Server-side speech-to-text was not added.
- The Workflows and Connectors pages state that nothing runs. They must not be changed to simulate success before the underlying features exist.

