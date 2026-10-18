# P-Dot Team Roadmap & Cross-Role Handoff Notes

This document aligns Person A (Frontend), Person B (Backend/Database/Infra), and Person C (AI Layer) on current progress, architectural contracts, and upcoming tasks.

---

## 1. Notes for Person A (Frontend & Apps)

### What the AI Layer is sending now
- **NDJSON Streaming**: The `/api/chat` route streams JSON chunks:
  - `{ "type": "delta", "text": "..." }` for partial text.
  - `{ "type": "search", "status": "used" | "failed" | "no_results", "sources": [{ "title": "...", "url": "..." }] }` when web search is invoked.
  - `{ "type": "done", "conversationId": "...", "messageId": "..." }` on completion.

### Immediate Frontend Needs
1. **FE-02: Safe Markdown & Citation Badges (High Priority)**
   - **Current State**: `MessageView.tsx` renders text directly via `<div className="message-content">{message.content}</div>`. Plain text only.
   - **Requirement**: Use a safe markdown renderer (e.g., `react-markdown` with `rehype-sanitize`) and syntax highlighting for code blocks with a "Copy" button.
   - **Citation Links**: Model outputs citations as `[1]`, `[2]`. Render these as clickable superscript badges that scroll to or highlight the corresponding item in the `SourceList`.

2. **FE-04: Action Cards (Approve / Edit / Cancel)**
   - When the assistant outputs structured actions (e.g. creating a reminder or saving a task), the UI should render an interactive Card with:
     - Action type and details (e.g., "Set Reminder: Call Doctor at 9:00 AM").
     - **Approve**, **Edit**, and **Cancel** buttons.
     - Confirmation state once approved.

3. **FE-05: "What P-Dot Remembers" & Document Screen**
   - A settings screen listing all items from `user_memories` with an option to delete or edit memories.
   - A document upload screen allowing users to drag-and-drop PDFs/TXT files to be indexed for RAG.

---

## 2. Notes for Person B (Backend, Supabase & Infra)

### Immediate Database & Infrastructure Needs
1. **Enable `pgvector` Extension**
   - Needed for **AI-05 (Vector RAG)** and **AI-06 (Long-term Memory)**.
   - Add to a new migration:
     ```sql
     create extension if not exists vector;
     ```

2. **New Tables Required in Supabase Migrations**
   - **`user_profiles`**:
     - `user_id` (uuid references auth.users), `full_name`, `timezone`, `preferences` (jsonb), `created_at`, `updated_at`.
   - **`user_memories`**:
     - `id` (uuid), `user_id` (uuid), `content` (text), `category` (text), `embedding` (vector(4096) for Qwen3-Embedding-8B or vector(1024)), `created_at`.
   - **`user_tasks` / `user_reminders`**:
     - `id` (uuid), `user_id` (uuid), `title` (text), `due_at` (timestamptz), `status` ('pending', 'completed', 'dismissed'), `created_at`.
   - **`user_documents` & `document_chunks`**:
     - `user_documents`: `id`, `user_id`, `filename`, `file_path`, `file_size`, `mime_type`, `created_at`.
     - `document_chunks`: `id`, `document_id`, `user_id`, `chunk_index`, `content`, `embedding` (vector), `created_at`.

3. **Supabase Storage Bucket**
   - Create a private bucket: `documents`.
   - Add RLS policy: users can only upload, read, and delete objects in their own folder (`auth.uid() = (storage.foldername(name))[1]`).

4. **Cloudflare Worker Keepalive / Streaming Timeouts**
   - Ensure streaming responses on Cloudflare Workers flush keepalive heartbeats if tool execution (search or RAG) takes >5 seconds.

---

## 3. Person C (AI Layer) — Master TODO & Roadmap

### Completed:
- [x] **AI-01: Nebius Model Audit & Selection**
  - Confirmed active model: `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B`.
  - Audited pricing: $0.06 / $0.24 per 1M tokens (~189k turns for $25 budget).
  - Confirmed tool-calling support and EU zero-training data retention.
  - Documented in `docs/decisions/0005-nebius-model-selection-and-audit.md`.
- [x] **AI-04 (Part 1): Autonomous Web Search Tool Calling**
  - Created tool schema in `src/server/assistant/tools.ts`.
  - Implemented streaming tool chunk parser in `src/server/providers/nebius/client.ts`.
  - Implemented model-driven autonomous tool dispatch in `src/server/assistant/service.ts`.
  - Verified with 114 unit tests passing.

### Upcoming Steps:
- [ ] **AI-02: 50-Prompt Evaluation Test Suite (IMMEDIATE NEXT STEP)**
  - Build automated eval runner to validate real-world performance of Nemotron 30B.
  - 50 prompts covering:
    - Real-time queries requiring search vs. general knowledge.
    - Hallucination and citation accuracy (`[1]`, `[2]`).
    - Adversarial attacks, jailbreaks, delimiter escape (`</web_search_results>`).
    - Token economy checks.
- [ ] **AI-03: Multi-Model Tiering, Dynamic Fallbacks & Smart Context Compaction**
  - Configure secondary fallback model (e.g. `Qwen/Qwen3-30B-A3B-Instruct-2507` or `Nemotron-3_5-Lightning`).
  - Implement automatic failover if primary Nebius model returns 503, 429, or timeouts.
  - **AI-03b: Smart Rolling Summary (Context Compaction)**: When conversation history exceeds 20 messages / 16k chars, run a lightweight background summarizer to compress older turns into a rolling context summary so the bot preserves key decisions without blowing token budgets.
  - **AI-03c: Smart Topic Title Generation**: Replace naive 60-character truncation in `titleFromMessage()` with a fast 1-token-efficient model call to generate a concise 3-5 word topic title after the first turn.
- [ ] **AI-04 (Part 2): Multi-Step Tool Loop & Action Proposing Tools**
  - Upgrade tool loop from 1-hop to multi-hop (up to 3 iterations).
  - Add `propose_action` tool (`create_reminder`, `add_task`) so the model can trigger frontend action cards.
- [ ] **AI-05: Vector RAG (Document Search)**
  - Integrate Nebius `Qwen/Qwen3-Embedding-8B` ($0.01 / 1M tokens).
  - Implement document chunking (recursive character splitter, 500-token chunks with 50-token overlap).
  - Implement vector similarity query against Supabase `document_chunks`.
- [ ] **AI-06: Long-Term Memory System**
  - Implement `save_memory` tool for autonomous fact extraction.
  - Build hybrid retrieval: semantic search on `user_memories` + static `user_profiles` injection into system prompt.
  - **AI-06b: Episodic Session Summarization**: Summarize key user takeaways at the end of a session into durable memories.
  - Add memory recall tool to retrieve historical notes across past conversations.
