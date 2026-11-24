-- Fix: match_past_year_by_exam ordered by question number FIRST and by
-- similarity only as a tie-break, the reverse of what
-- migrate_add_past_year_exam_lane.sql says it does ("matrix questions from
-- Johor 2023 should lead with matrices ... pass a null embedding to get a
-- stable order by question number instead"). The leading
-- `case when query_embedding is null then 0 else 1 end` is constant within a
-- call, so it never switched anything.
--
-- Found in the Phase 5 answer eval (RAG_STATUS.md): "Dalam soalan percubaan
-- Pahang 2023, apakah isu pembangunan ekonomi ... Rancangan Malaysia Pertama?"
-- returned Pahang 2023 Chemistry and Mathematics questions numbered (03),
-- (06), (08), (NO 1) — 10 of 10 slots — while the Sejarah Pahang 2023
-- question on exactly that topic (labelled, in content_chunks) never made the
-- cut. The tutor then told the student there was no Sejarah Pahang paper.
--
-- Now: similarity first; with a null embedding every distance is null, so the
-- order falls through to question number as documented. Membership (the where
-- clause) is unchanged, so this still can never return another state or year.
-- Same signature and return type, so create or replace is enough.

create or replace function match_past_year_by_exam(
  query_embedding vector(768) default null,
  match_count int default 12,
  p_subject text default null,
  p_year smallint default null,
  p_authority text default null,
  p_district text default null
)
returns table (
  id uuid,
  content text,
  source text,
  content_type text,
  difficulty text,
  material_id uuid,
  subject text,
  topic text,
  exam_year smallint,
  exam_authority text,
  exam_district text,
  exam_question_no text,
  source_page_images text[]
)
language sql stable
as $$
  select c.id, c.content, c.source, c.content_type, c.difficulty, c.material_id,
         c.subject, c.topic, c.exam_year, c.exam_authority, c.exam_district,
         c.exam_question_no, c.source_page_images
  from content_chunks c
  where c.content_type = 'past_year_question'
    and (p_subject   is null or c.subject        = p_subject)
    and (p_year      is null or c.exam_year      = p_year)
    and (p_authority is null or c.exam_authority = p_authority)
    and (p_district  is null or c.exam_district  = p_district)
  order by
    c.embedding <=> query_embedding,
    -- nulls last so a question with no printed number doesn't lead the set
    c.exam_question_no nulls last
  limit match_count;
$$;
