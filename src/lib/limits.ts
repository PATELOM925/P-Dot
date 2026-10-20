// Request and context bounds. Shared so the UI can enforce the same limits the API does.

/** Maximum characters in one user message (~2,000 tokens). */
export const MAX_MESSAGE_CHARS = 8_000;

/** Maximum size of a POST /api/chat body (16 KB). */
export const MAX_CHAT_BODY_BYTES = 16 * 1024;

/** Most recent messages loaded from storage when building model context. */
export const HISTORY_MESSAGE_LIMIT = 50;

/**
 * Character budget for conversation history sent to the model (~16k tokens at
 * roughly 4 characters per token). Older messages are dropped first.
 */
export const HISTORY_CHAR_BUDGET = 64_000;

/** Hard stop for a single assistant reply (the database allows 32k). */
export const MAX_ASSISTANT_CHARS = 30_000;

/** Web search bounds. */
export const SEARCH_MAX_RESULTS = 5;
export const SEARCH_EXCERPT_CHARS = 1_200;
export const SEARCH_QUERY_CHARS = 400;

/** Messages returned when reopening a conversation (no pagination in the MVP). */
export const CONVERSATION_MESSAGE_LIMIT = 200;

/** Conversations returned by the history list. */
export const CONVERSATION_LIST_LIMIT = 50;
