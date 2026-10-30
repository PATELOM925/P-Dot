// Request and context bounds. Shared so the UI can enforce the same limits the API does.

/** Maximum characters in one user message. */
export const MAX_MESSAGE_CHARS = 4_000;

/** Maximum size of a POST /api/chat body. */
export const MAX_CHAT_BODY_BYTES = 16 * 1024;

/** Most recent messages loaded from storage when building model context. */
export const HISTORY_MESSAGE_LIMIT = 40;

/**
 * Character budget for conversation history sent to the model (~6k tokens at
 * roughly 4 characters per token). Older messages are dropped first.
 */
export const HISTORY_CHAR_BUDGET = 24_000;

/** Hard stop for a single assistant reply (the database allows 32k). */
export const MAX_ASSISTANT_CHARS = 30_000;

/** Web search bounds. */
export const SEARCH_MAX_RESULTS = 5;
export const SEARCH_EXCERPT_CHARS = 1_200;
export const SEARCH_QUERY_CHARS = 400;

/** Messages returned when reopening a conversation (no pagination in the MVP). */
export const CONVERSATION_MESSAGE_LIMIT = 200;

/** Longest conversation title or task title. */
export const MAX_TITLE_CHARS = 120;
export const MAX_TASK_CHARS = 200;

/** Tasks returned per mode. */
export const TASK_LIST_LIMIT = 200;

/** Conversations returned by the history list. */
export const CONVERSATION_LIST_LIMIT = 50;

// Memory, documents, actions, reminders (decision 0009).
export const MAX_MEMORY_CHARS = 1_000;
export const MEMORY_LIST_LIMIT = 200;
export const MAX_DOCUMENT_TITLE_CHARS = 200;
/** About 25,000 tokens: at most about 56 chunks, under $0.001 to embed. */
export const MAX_DOCUMENT_CHARS = 100_000;
/** Request body limit for a document upload (JSON with the text). */
export const MAX_DOCUMENT_BODY_BYTES = 512 * 1024;
export const DOCUMENT_LIST_LIMIT = 100;
export const DOCUMENT_CHUNK_CHARS = 2_000;
export const DOCUMENT_CHUNK_OVERLAP_CHARS = 200;
export const MAX_DOCUMENT_CHUNKS = 100;
/**
 * A document still "processing" after this time is stale: the upload stopped
 * before its final status write. An upload takes at most a few minutes
 * (4 embedding batches with a 20 s timeout each).
 */
export const DOCUMENT_PROCESSING_STALE_MS = 10 * 60 * 1000;
/** Most stale documents one list request settles. Later requests settle the rest. */
export const STALE_DOCUMENT_SETTLE_LIMIT = 5;
/**
 * How long a claim to write a reply lasts (decision 0012). It must be longer
 * than the longest chat turn: the heavy tier deadline, which all tool hops
 * and tool runs share, plus the first search and the memory embedding.
 */
export const REPLY_CLAIM_LEASE_SECONDS = 300;
export const MAX_REMINDER_TITLE_CHARS = 200;

/** External actions (decision 0014). The same limits as normalize_action_payload in the migration. */
export const MAX_EMAIL_RECIPIENTS = 10;
export const MAX_EMAIL_ADDRESS_CHARS = 254;
/** All recipients together, so a proposal stays readable on its card. */
export const MAX_EMAIL_RECIPIENTS_TOTAL_CHARS = 2000;
export const MAX_EMAIL_SUBJECT_CHARS = 200;
export const MAX_EMAIL_BODY_CHARS = 4000;
export const MAX_EVENT_TITLE_CHARS = 200;
export const MAX_EVENT_ATTENDEES = 20;
export const MAX_EVENT_DAYS = 31;
/**
 * A claimed external action that has no outcome after this long can be
 * recovered. Much more than a token refresh (10 s) plus the Google call (15 s).
 */
export const EXTERNAL_ACTION_LEASE_SECONDS = 120;
export const REMINDER_LIST_LIMIT = 200;
export const MAX_ACTION_SUMMARY_CHARS = 300;
export const ACTION_LIST_LIMIT = 100;
export const ACTION_LOG_LIMIT = 200;
/** Active memories put in each chat turn (decision 0013). */
export const MEMORY_CONTEXT_COUNT = 4;
/** Matches returned by similarity search (the database caps it at 20). */
export const RETRIEVAL_MATCH_COUNT = 5;
/** Embedding size. Must match vector(1024) in the database. */
export const EMBEDDING_DIMENSIONS = 1_024;
/** Texts per embedding request. */
export const EMBEDDING_BATCH_SIZE = 32;
