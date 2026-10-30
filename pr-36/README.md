Proof images for PR #36 (chat fixes), made on commit 5d12e63. Each shot is at 1280x800 and at 393x852 (DPR 3).

- memory-card: the user sends "Remember that I prefer short answers". The model calls save_memory. The reply shows the "Remember this?" card with "Prefers short answers".
- false-claim-removed: a second turn, "add a task to buy milk". The model writes "I've proposed a task to buy milk. Please approve it below." and calls no tool. The saved reply in the `done` event is "No card was made for this request, so nothing was added or saved. Send the request again to get a card." The false claim does not show.
- citations: web search on, 2 sources. The model text came in the chunks "Union Coffee 【", "2†L1", "-L4】 is close. Pilot Cafe 【1】.". The deltas and the saved reply hold "[2]" and "[1]". The page shows two chips and no raw tokens.
- step-line-documents: the line during the stream is "Searching your documents for “lease renewal date”…", not "Working".
- step-line-writing: the same turn after the first text: "Writing the reply…".
- timezone: the browser ran with timezoneId Asia/Kolkata. The reminder card for "tomorrow at 6pm" shows "Oct 15, 2026, 6:00 PM".

The request body that the page sent for the timezone shot:

```json
{"action":"send","message":"Remind me to call mom tomorrow at 6pm","webSearch":false,"effort":"auto","mode":"personal","timeZone":"Asia/Calcutta"}
```

Note: headless Chromium gives the old alias "Asia/Calcutta" for timezoneId Asia/Kolkata. The server accepts it: `isValidTimeZone("Asia/Calcutta")` is true and `localTime` gives the offset +05:30. The events for the shot came from a turn with "timeZone": "Asia/Kolkata". The system prompt of that turn had: "The user's time zone is Asia/Kolkata (UTC+05:30). The user's local date and time now is Wednesday, 2026-10-14 18:00."

How the events were made: a vitest script outside the repo ran the real prepareChatTurn and streamChatTurn (src/server/assistant/service.ts) with a scripted fake model and the fakes in tests/support/fakes.ts. It saved the NDJSON events, the messages, the memory row and the proposal row. The real chat page ran in the dev server. A local page that is not committed rendered the real ChatWorkspace, the same method as the earlier proofs. In the browser, a fetch stand-in played the events back for /api/chat and gave the saved rows for conversations, memories and actions. The fake dates are October 2026.

No real keys, no real accounts, no paid provider. The dev server ran without .env.local.
