-- Memory, document search, action proposals, the action log, reminders and
-- context records ("what was sent"). Decision 0009.
--
-- Same ownership model as every earlier migration: the app uses only the
-- signed-in user's session, every row has user_id = auth.uid(), and RLS
-- refuses anything else. Every change here is additive, so the code that is
-- live now keeps working after this migration runs.

create extension if not exists vector with schema extensions;

-- Composite keys let child rows prove they belong to the same user.
alter table public.messages
  add constraint messages_id_user_unique unique (id, user_id);

-- ---------------------------------------------------------------------------
-- Shared trigger: keep updated_at current.
-- ---------------------------------------------------------------------------
create function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

revoke execute on function public.touch_updated_at() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Memories: facts the user can see, edit and delete.
-- status 'proposed': suggested by the assistant, waiting for the user.
-- status 'active': used in replies.
-- ---------------------------------------------------------------------------
create table public.memories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  mode text not null check (mode in ('personal', 'work')),
  content text not null check (char_length(content) between 1 and 1000),
  status text not null default 'active' check (status in ('proposed', 'active')),
  source text not null check (source in ('user', 'assistant')),
  source_message_id uuid,
  embedding extensions.vector(1024),
  embedding_model text check (embedding_model is null or char_length(embedding_model) <= 120),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id),
  -- The source message must be the same user's. Deleting it keeps the memory.
  foreign key (source_message_id, user_id)
    references public.messages (id, user_id) on delete set null (source_message_id)
);

create index memories_user_mode_created_idx on public.memories (user_id, mode, created_at desc);
create index memories_embedding_idx on public.memories
  using hnsw (embedding extensions.vector_cosine_ops);

create trigger memories_touch_updated_at
  before update on public.memories
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Documents and their searchable chunks (plain text only for now).
-- ---------------------------------------------------------------------------
create table public.documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  mode text not null check (mode in ('personal', 'work')),
  title text not null check (char_length(title) between 1 and 200),
  media_type text not null check (media_type in ('text/plain', 'text/markdown')),
  char_count integer not null check (char_count between 1 and 200000),
  status text not null default 'processing' check (status in ('processing', 'ready', 'failed')),
  created_at timestamptz not null default now(),
  unique (id, user_id)
);

create index documents_user_mode_created_idx on public.documents (user_id, mode, created_at desc);

create table public.document_chunks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  document_id uuid not null,
  chunk_index integer not null check (chunk_index between 0 and 999),
  content text not null check (char_length(content) between 1 and 4000),
  embedding extensions.vector(1024),
  embedding_model text check (embedding_model is null or char_length(embedding_model) <= 120),
  created_at timestamptz not null default now(),
  unique (document_id, chunk_index),
  foreign key (document_id, user_id)
    references public.documents (id, user_id) on delete cascade
);

create index document_chunks_user_idx on public.document_chunks (user_id, document_id);
create index document_chunks_embedding_idx on public.document_chunks
  using hnsw (embedding extensions.vector_cosine_ops);

-- ---------------------------------------------------------------------------
-- Action proposals: the assistant proposes, the user approves or rejects.
-- Nothing with an effect runs without an approved proposal.
-- ---------------------------------------------------------------------------
create table public.action_proposals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  conversation_id uuid,
  kind text not null check (kind in ('create_task', 'create_reminder', 'save_memory')),
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and pg_column_size(payload) <= 8192),
  summary text not null check (char_length(summary) between 1 and 300),
  status text not null default 'proposed'
    check (status in ('proposed', 'approved', 'rejected', 'executed', 'failed')),
  result jsonb check (result is null or (jsonb_typeof(result) = 'object' and pg_column_size(result) <= 8192)),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  unique (id, user_id),
  foreign key (conversation_id, user_id)
    references public.conversations (id, user_id) on delete set null (conversation_id)
);

create index action_proposals_user_status_idx on public.action_proposals (user_id, status, created_at desc);

-- ---------------------------------------------------------------------------
-- Action log: an append-only record of what happened. No message text.
-- ---------------------------------------------------------------------------
create table public.action_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  proposal_id uuid,
  event text not null check (event in (
    'proposed', 'approved', 'rejected', 'executed', 'failed',
    'memory_added', 'memory_edited', 'memory_deleted',
    'document_added', 'document_deleted',
    'reminder_added', 'reminder_changed', 'reminder_deleted'
  )),
  detail jsonb not null default '{}'::jsonb
    check (jsonb_typeof(detail) = 'object' and pg_column_size(detail) <= 4096),
  created_at timestamptz not null default now(),
  foreign key (proposal_id, user_id)
    references public.action_proposals (id, user_id) on delete set null (proposal_id)
);

create index action_log_user_created_idx on public.action_log (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Reminders. Delivery (scheduled jobs, push) comes in a later change.
-- ---------------------------------------------------------------------------
create table public.reminders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  mode text not null check (mode in ('personal', 'work')),
  title text not null check (char_length(title) between 1 and 200),
  due_at timestamptz not null,
  status text not null default 'scheduled' check (status in ('scheduled', 'done', 'cancelled')),
  proposal_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (proposal_id, user_id)
    references public.action_proposals (id, user_id) on delete set null (proposal_id)
);

create index reminders_user_mode_due_idx on public.reminders (user_id, mode, due_at);
create index reminders_due_idx on public.reminders (due_at) where status = 'scheduled';

create trigger reminders_touch_updated_at
  before update on public.reminders
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Context records ("what was sent"): for each assistant reply, which kinds of
-- context went to the model. IDs and counts only; no copied text.
-- ---------------------------------------------------------------------------
create table public.context_records (
  message_id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  model text not null check (char_length(model) <= 120),
  history_message_count integer not null check (history_message_count between 0 and 1000),
  history_chars integer not null check (history_chars between 0 and 1000000),
  memory_ids uuid[] not null default '{}' check (cardinality(memory_ids) <= 50),
  document_chunk_ids uuid[] not null default '{}' check (cardinality(document_chunk_ids) <= 50),
  web_source_count integer not null default 0 check (web_source_count between 0 and 20),
  prompt_version text not null check (char_length(prompt_version) <= 40),
  input_tokens integer check (input_tokens is null or input_tokens >= 0),
  output_tokens integer check (output_tokens is null or output_tokens >= 0),
  created_at timestamptz not null default now(),
  foreign key (message_id, user_id)
    references public.messages (id, user_id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- Similarity search. SECURITY INVOKER, so RLS applies and the explicit
-- user filter is a second check. The count is capped at 20.
-- ---------------------------------------------------------------------------
create function public.match_memories(p_query extensions.vector(1024), p_mode text, p_count integer)
returns table (id uuid, content text, similarity double precision)
language sql
stable
security invoker
set search_path = ''
as $$
  select m.id, m.content, 1 - (m.embedding operator(extensions.<=>) p_query) as similarity
  from public.memories m
  where m.user_id = (select auth.uid())
    and m.mode = p_mode
    and m.status = 'active'
    and m.embedding is not null
  order by m.embedding operator(extensions.<=>) p_query
  limit least(greatest(coalesce(p_count, 5), 1), 20);
$$;

create function public.match_document_chunks(p_query extensions.vector(1024), p_mode text, p_count integer)
returns table (id uuid, document_id uuid, title text, content text, similarity double precision)
language sql
stable
security invoker
set search_path = ''
as $$
  select c.id, c.document_id, d.title, c.content,
         1 - (c.embedding operator(extensions.<=>) p_query) as similarity
  from public.document_chunks c
  join public.documents d on d.id = c.document_id and d.user_id = c.user_id
  where c.user_id = (select auth.uid())
    and d.mode = p_mode
    and d.status = 'ready'
    and c.embedding is not null
  order by c.embedding operator(extensions.<=>) p_query
  limit least(greatest(coalesce(p_count, 5), 1), 20);
$$;

revoke execute on function public.match_memories(extensions.vector, text, integer) from public, anon;
revoke execute on function public.match_document_chunks(extensions.vector, text, integer) from public, anon;
grant execute on function public.match_memories(extensions.vector, text, integer) to authenticated;
grant execute on function public.match_document_chunks(extensions.vector, text, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- Row-level security.
-- ---------------------------------------------------------------------------
alter table public.memories enable row level security;
alter table public.documents enable row level security;
alter table public.document_chunks enable row level security;
alter table public.action_proposals enable row level security;
alter table public.action_log enable row level security;
alter table public.reminders enable row level security;
alter table public.context_records enable row level security;

create policy memories_select_own on public.memories
  for select to authenticated using ((select auth.uid()) = user_id);
create policy memories_insert_own on public.memories
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy memories_update_own on public.memories
  for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy memories_delete_own on public.memories
  for delete to authenticated using ((select auth.uid()) = user_id);

create policy documents_select_own on public.documents
  for select to authenticated using ((select auth.uid()) = user_id);
create policy documents_insert_own on public.documents
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy documents_update_own on public.documents
  for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy documents_delete_own on public.documents
  for delete to authenticated using ((select auth.uid()) = user_id);

create policy document_chunks_select_own on public.document_chunks
  for select to authenticated using ((select auth.uid()) = user_id);
create policy document_chunks_insert_own on public.document_chunks
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy document_chunks_delete_own on public.document_chunks
  for delete to authenticated using ((select auth.uid()) = user_id);

create policy action_proposals_select_own on public.action_proposals
  for select to authenticated using ((select auth.uid()) = user_id);
create policy action_proposals_insert_own on public.action_proposals
  for insert to authenticated with check ((select auth.uid()) = user_id and status = 'proposed');
create policy action_proposals_update_own on public.action_proposals
  for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

create policy action_log_select_own on public.action_log
  for select to authenticated using ((select auth.uid()) = user_id);
create policy action_log_insert_own on public.action_log
  for insert to authenticated with check ((select auth.uid()) = user_id);

create policy reminders_select_own on public.reminders
  for select to authenticated using ((select auth.uid()) = user_id);
create policy reminders_insert_own on public.reminders
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy reminders_update_own on public.reminders
  for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy reminders_delete_own on public.reminders
  for delete to authenticated using ((select auth.uid()) = user_id);

create policy context_records_select_own on public.context_records
  for select to authenticated using ((select auth.uid()) = user_id);
create policy context_records_insert_own on public.context_records
  for insert to authenticated with check ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------------
-- Grants: no access for anon; column-level updates only where the app needs
-- them; the action log and context records are append-only.
-- ---------------------------------------------------------------------------
revoke all on public.memories, public.documents, public.document_chunks, public.action_proposals,
  public.action_log, public.reminders, public.context_records from anon;

revoke update on public.memories, public.documents, public.document_chunks, public.action_proposals,
  public.action_log, public.reminders, public.context_records from authenticated;
revoke delete on public.action_proposals, public.action_log, public.context_records from authenticated;

grant update (mode, content, status, embedding, embedding_model) on public.memories to authenticated;
grant update (status) on public.documents to authenticated;
grant update (status, result, decided_at) on public.action_proposals to authenticated;
grant update (mode, title, due_at, status) on public.reminders to authenticated;
