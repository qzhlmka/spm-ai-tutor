-- Exposes material_id from match_content_chunks so chat-handler.ts can tell
-- the tutor which retrieved chunks came from a teacher's own uploaded class
-- material (content_chunks.material_id is not null) vs standard textbook
-- ingestion — see the comment above TUTOR_SYSTEM_PROMPT's "teacher-uploaded
-- material" paragraph in src/lib/chat-handler.ts for why this matters.
--
-- Postgres won't let CREATE OR REPLACE change a function's return row type
-- (adding a column counts as a change), so the old signature must be dropped
-- first.
drop function if exists match_content_chunks(vector, int);

create or replace function match_content_chunks(
  query_embedding vector(768),
  match_count int default 5
)
returns table (
  id uuid,
  content text,
  source text,
  content_type text,
  difficulty text,
  material_id uuid
)
language sql stable
as $$
  select id, content, source, content_type, difficulty, material_id
  from content_chunks
  order by embedding <=> query_embedding
  limit match_count;
$$;
