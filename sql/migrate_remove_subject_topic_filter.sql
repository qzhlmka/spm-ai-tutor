-- The platform is no longer scoped to one subject at chat time — drop the
-- subject/topic pre-filter from match_content_chunks and do a pure vector
-- search across the whole knowledge base instead. `content_chunks.subject`
-- and `.topic` columns are untouched (still useful ingestion/citation
-- metadata), only the RPC signature changes.

drop function if exists match_content_chunks(vector(768), text, text, int);

create or replace function match_content_chunks(
  query_embedding vector(768),
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
  order by embedding <=> query_embedding
  limit match_count;
$$;
