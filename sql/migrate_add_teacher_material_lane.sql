-- Dedicated retrieval lane for teacher-uploaded material.
--
-- WHY THIS EXISTS
-- match_content_chunks searches the whole knowledge base, where a handful of
-- teacher-uploaded chunks compete against thousands of textbook chunks on the
-- same topic. Measured against the real KB (34 teacher chunks vs ~1,989
-- Chemistry textbook chunks, including a full Carbon Compound chapter), a
-- teacher's own Carbon Compound notes ranked 6th-7th for genuine requests like
-- "what did my teacher teach about carbon compound", and fell outside the top 8
-- entirely for "explain homologous series in carbon compounds" — so the tutor
-- never saw the material at all, no matter how the download-chip gate was
-- tuned. Restricting the search to material_id IS NOT NULL lets teacher
-- material compete only against other teacher material. In that lane, every
-- one of those queries returns the correct chunk first.
--
-- This function also returns `similarity`, which match_content_chunks does
-- not, so callers can gate on ACTUAL relevance rather than rank. `<=>` is
-- cosine distance; embeddings.ts produces L2-normalised vectors, so
-- 1 - distance is cosine similarity. See TEACHER_MATERIAL_MIN_SIMILARITY in
-- src/lib/chat-handler.ts for the tuned cutoff and how it was measured.

create or replace function match_teacher_materials(
  query_embedding vector(768),
  match_count int default 3
)
returns table (
  id uuid,
  content text,
  source text,
  content_type text,
  difficulty text,
  material_id uuid,
  similarity double precision
)
language sql stable
as $$
  select
    id,
    content,
    source,
    content_type,
    difficulty,
    material_id,
    1 - (embedding <=> query_embedding) as similarity
  from content_chunks
  where material_id is not null
  order by embedding <=> query_embedding
  limit match_count;
$$;

-- Partial HNSW index so this lane doesn't degrade into a sequential scan as
-- teacher uploads accumulate. The table's existing full index can't serve a
-- filtered query; a partial index over exactly the filtered subset can, and it
-- stays small because teacher material is a fraction of content_chunks.
create index if not exists content_chunks_material_embedding_idx
  on content_chunks using hnsw (embedding vector_cosine_ops)
  where material_id is not null;
