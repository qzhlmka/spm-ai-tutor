-- Run this ONLY after `npm run reembed` has backfilled embedding_768 for
-- every row in content_chunks (verify with the query below before running).
--
--   select count(*) from content_chunks where embedding_768 is null;
--   -- must return 0
--
-- Swaps the old 1536-dim OpenAI column out for the new 768-dim gte-base one.

drop index if exists content_chunks_embedding_idx;

alter table content_chunks drop column embedding;
alter table content_chunks rename column embedding_768 to embedding;

create index content_chunks_embedding_idx
  on content_chunks using hnsw (embedding vector_cosine_ops);

create or replace function match_content_chunks(
  query_embedding vector(768),
  match_subject text,
  match_topic text,
  match_count int default 5
)
returns table (
  id uuid,
  content text,
  source text,
  content_type text,
  difficulty text
)
language sql stable
as $$
  select id, content, source, content_type, difficulty
  from content_chunks
  where subject = match_subject
    and topic = match_topic
  order by embedding <=> query_embedding
  limit match_count;
$$;
