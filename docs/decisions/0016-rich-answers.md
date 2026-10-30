# 0016: Rich answers: citations, sources and cards

- Status: Proposed (2026-10-30).
- Related: [0013 tools](0013-ai-tools-and-scope.md), [0015 trial](0015-judge-demo-mode.md).
- Code: `src/features/chat/markdown/`, `src/features/chat/AssistantReply.tsx`, `src/features/chat/SourceRow.tsx`, `src/features/chat/rich/`, `src/lib/rich-blocks.ts`, `src/lib/maps-url.ts`, `src/features/chat/useStickToBottom.ts`.

## Decision

- **Renderer.** P-Dot's own small Markdown parser (no dependency) makes React elements only. Raw HTML stays text. Images never load: they show as "Image not shown: {alt}". Every link passes `toSafeHttpUrl`. Parsing is linear in the length of the reply.
- **Citations.** `[n]` is a number chip for source n. Hover or focus shows the host and title. A click opens the source list at source n and marks it for 1.2 seconds. It never opens the outside page. A number without a source stays muted text.
- **Sources.** One line under the reply: "N sources · M cited · host, host, +k". Open, it lists cited sources first, with the line "P-Dot used these pages as context. They do not prove the answer." A source keeps its number when its link is removed. No favicons: a favicon request tells a third party which sites the user reads.
- **Cards.** A reply can hold up to 3 fenced blocks `pdot-places`, `pdot-table`, `pdot-checklist` and `pdot-steps` with strict JSON (zod `strictObject`, at most 6,000 characters). No field takes a URL. A block that fails shows as code with "P-Dot could not show this as a card." While a block streams, a placeholder shows, never the JSON.
- **Places.** Offered in the prompt only when web search found sources, because places without sources would be made up. The card shows name, kind, area, note and citations. P-Dot builds the "Open in Maps" link (a Google Maps search URL, no API key) from the name, area and city. No coordinates, addresses, ratings, hours or embedded map: the model would make them up, and a map embed sends the user's IP to the tile server.
- **Scroll.** The list follows a reply only while the user is within 80 px of the bottom. Otherwise it stays still and shows "Jump to latest". A send always goes to the end.

## Limits

- The places rule is in the system prompt only when the first web search of the turn found sources. A search that the model starts in a later tool hop does not add it.
- The prompt asks for blocks; whether a model uses them well is not measured yet (no live eval run).
- Chips use the source numbers of the saved reply. Older replies that cite numbers above their source count show muted text.
