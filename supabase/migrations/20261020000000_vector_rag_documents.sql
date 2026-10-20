-- P-Dot Vector RAG: Personal Documents and Embedding Chunks.
--
-- Enables pgvector, creates user_documents and document_chunks tables,
-- establishes HNSW vector index for Qwen3-Embedding-8B (4096 dimensions),
-- and provides match_document_chunks() RPC with strict user RLS boundaries.

-- ---------------------------------------------------------------------------
-- Extension
-- ---------------------------------------------------------------------------
create extension if not exists vector with schema public;

-- ---------------------------------------------------------------------------
-- User Documents
-- ---------------------------------------------------------------------------
create table if not exists public.user_documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  filename text not null check (char_length(filename) between 1 and 255),
  file_path text,
  file_size integer not null default 0 check (file_size >= 0),
  mime_type text not null default 'text/plain',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id)
);

create index if not exists user_documents_user_updated_idx
  on public.user_documents (user_id, updated_at desc);

-- ---------------------------------------------------------------------------
-- Document Chunks & Vector Embeddings
-- ---------------------------------------------------------------------------
create table if not exists public.document_chunks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  chunk_index integer not null check (chunk_index >= 0),
  content text not null check (char_length(content) between 1 and 16000),
  embedding vector(4096) not null,
  created_at timestamptz not null default now(),
  foreign key (document_id, user_id)
    references public.user_documents (id, user_id) on delete cascade
);

create index if not exists document_chunks_doc_chunk_idx
  on public.document_chunks (document_id, chunk_index);

create index if not exists document_chunks_user_idx
  on public.document_chunks (user_id);

-- HNSW vector cosine similarity index for fast approximate nearest neighbor search
create index if not exists document_chunks_embedding_hnsw_idx
  on public.document_chunks using hnsw (embedding vector_cosine_ops);

-- ---------------------------------------------------------------------------
-- Similarity Search RPC
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

revoke execute on function public.match_document_chunks(vector, float, int) from public, anon;
grant execute on function public.match_document_chunks(vector, float, int) to authenticated;

-- ---------------------------------------------------------------------------
-- Row-Level Security
-- ---------------------------------------------------------------------------
alter table public.user_documents enable row level security;
alter table public.document_chunks enable row level security;

create policy user_documents_select_own on public.user_documents
  for select to authenticated using ((select auth.uid()) = user_id);
create policy user_documents_insert_own on public.user_documents
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy user_documents_delete_own on public.user_documents
  for delete to authenticated using ((select auth.uid()) = user_id);

create policy document_chunks_select_own on public.document_chunks
  for select to authenticated using ((select auth.uid()) = user_id);
create policy document_chunks_insert_own on public.document_chunks
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy document_chunks_delete_own on public.document_chunks
  for delete to authenticated using ((select auth.uid()) = user_id);

-- Least-privilege table grants on top of RLS
revoke all on public.user_documents, public.document_chunks from anon;
revoke update on public.user_documents, public.document_chunks from authenticated;
