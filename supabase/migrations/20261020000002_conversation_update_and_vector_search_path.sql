-- Enable conversation updating for authenticated users (required for AI auto-titling and user renaming)
-- and fix vector operator search_path in similarity search RPCs.

-- ---------------------------------------------------------------------------
-- 1. Conversation Update Grants and Policies
-- ---------------------------------------------------------------------------
grant update (title, updated_at) on public.conversations to authenticated;

drop policy if exists conversations_update_own on public.conversations;
create policy conversations_update_own on public.conversations
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------------
-- 2. Vector Search Path Fix for Document Chunks
-- ---------------------------------------------------------------------------
create or replace function public.match_document_chunks(
  p_query_embedding vector(4096),
  p_match_threshold float default 0.25,
  p_match_count int default 5
)
returns table (
  id uuid,
  document_id uuid,
  filename text,
  chunk_index int,
  content text,
  similarity float
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  return query
  select
    c.id,
    c.document_id,
    d.filename,
    c.chunk_index,
    c.content,
    round((1 - (c.embedding <=> p_query_embedding))::numeric, 4)::float as similarity
  from public.document_chunks c
  join public.user_documents d on d.id = c.document_id and d.user_id = v_user
  where c.user_id = v_user
    and (1 - (c.embedding <=> p_query_embedding)) >= p_match_threshold
  order by c.embedding <=> p_query_embedding
  limit p_match_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Vector Search Path Fix for User Memories
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
set search_path = public, pg_temp
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
