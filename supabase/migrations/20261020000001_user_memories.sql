-- P-Dot Long-Term Memory System (AI-06)
--
-- Enables persistent personal memory storage and semantic vector retrieval
-- across user preferences, personal facts, work context, and durable notes.
-- Uses Qwen3-Embedding-8B (4096 dimensions) with strict RLS boundaries.

-- ---------------------------------------------------------------------------
-- User Memories Table
-- ---------------------------------------------------------------------------
create table if not exists public.user_memories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  content text not null check (char_length(content) between 1 and 2000),
  category text not null default 'general' check (category in ('preference', 'fact', 'work', 'personal', 'general')),
  embedding vector(4096) not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id)
);

create index if not exists user_memories_user_updated_idx
  on public.user_memories (user_id, updated_at desc);

create index if not exists user_memories_user_category_idx
  on public.user_memories (user_id, category);

-- ---------------------------------------------------------------------------
-- Memory Similarity Search RPC
-- ---------------------------------------------------------------------------
create or replace function public.match_user_memories(
  p_query_embedding vector(4096),
  p_match_threshold float default 0.2,
  p_match_count int default 5,
  p_category text default null
)
returns table (
  id uuid,
  content text,
  category text,
  similarity float,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  return query
  select
    m.id,
    m.content,
    m.category,
    round((1 - (m.embedding <=> p_query_embedding))::numeric, 4)::float as similarity,
    m.created_at
  from public.user_memories m
  where m.user_id = v_user
    and (p_category is null or m.category = p_category)
    and (1 - (m.embedding <=> p_query_embedding)) >= p_match_threshold
  order by m.embedding <=> p_query_embedding
  limit p_match_count;
end;
$$;

revoke execute on function public.match_user_memories(vector, float, int, text) from public, anon;
grant execute on function public.match_user_memories(vector, float, int, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Row-Level Security
-- ---------------------------------------------------------------------------
alter table public.user_memories enable row level security;

create policy user_memories_select_own on public.user_memories
  for select to authenticated using ((select auth.uid()) = user_id);

create policy user_memories_insert_own on public.user_memories
  for insert to authenticated with check ((select auth.uid()) = user_id);

create policy user_memories_update_own on public.user_memories
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

create policy user_memories_delete_own on public.user_memories
  for delete to authenticated using ((select auth.uid()) = user_id);

-- Least-privilege table grants on top of RLS
revoke all on public.user_memories from anon;
