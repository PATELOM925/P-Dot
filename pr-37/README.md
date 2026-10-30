Proof images for PR #37 (deep research and the morning brief), made on commit 8924f4e. Each shot is at 1280x800 and at 393x852 (DPR 3).

- 01-menu: the "+" menu with "Deep research" under "Search the web".
- 02-chip: "Deep research" is on as a chip above the message.
- 03-status-deep, 04-status-reading, 05-status-writing: the status lines "Searching the web (deep)…", "Reading 3 pages…" and "Writing the brief…".
- 06a-brief-reply-top and 06-brief-reply: the research brief with a short answer, "Key findings" with citation chips, a pdot-table card, "What sources disagree on", "Limits" and "6 sources · 6 cited".
- 07-today-card: the Morning brief card on Today, with topics.
- 08-today-status: "Searching today's news for “cricket”…" after the click.
- 09-today-done: the 5-bullet brief with citation chips and "Open in chat".
- 10-reopened: the saved conversation "Brief for Fri 30 Oct 2026" opened in chat, with "What was sent" open.
- sent-bodies.json: the request bodies the pages sent. Deep research sent "webSearch": true and "research": true. The brief sent "webSearch": false and "brief": {"topics": ["AI chips", "cricket", "local elections"], "date": "Fri 30 Oct 2026"}.

How the events were made: a vitest script that is not committed ran the real prepareChatTurn and streamChatTurn (src/server/assistant/service.ts) with fake Tavily research services, a scripted fake model and the fakes in tests/support/fakes.ts. In those runs:
- Deep research held Tavily credits 2 (search) and 1 (extract). The final user turn had 3 "Page text:" parts. The system message had no page text.
- The brief held 1 Tavily credit for each of the 3 topics. It saved one conversation titled "Brief for Fri 30 Oct 2026", one reply and one "what was sent" record.

The real ChatWorkspace and BriefCard ran on next dev, in a local page that is not committed. In the browser, a fetch stand-in played the events back for /api/chat and gave the saved rows for conversations and "What was sent".

No real keys, no real accounts, no paid provider. The dev server ran with empty provider keys and dummy public Supabase settings.
