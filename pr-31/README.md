Proof images for PR #31 (read-only Notion, Linear and Todoist connectors).

- 01, 02: the real McpCard component with fake connection data: connected with health flags, a tool that is not available, no refresh token, not connected, connect again with the "changed in another tab" message, load failed, not set up, and needs an account.
- 03: the real chat page, "+" menu with "Use Notion" on. "Search the web" is off and disabled. Desktop and 393 px.
- 04: a chat turn. The NDJSON events came from the real prepareChatTurn and streamChatTurn with a fake Notion MCP server (SSE), the real connector code, and a scripted fake model. The page played them back. The request body the page sent had "connectors": ["notion"] and "webSearch": false.

No real keys, no real accounts, no paid provider. The dev server ran without .env.local.
