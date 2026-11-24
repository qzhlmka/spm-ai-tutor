-- Exposes content_chunks.source_page_images (migrate_add_exam_page_images.sql)
-- from all four retrieval lanes, so chat-handler.ts can attach the real page
-- image to the tutor's vision-capable call instead of only ever showing it a
-- text description of a diagram it can't fully describe. See that migration
-- for why a text description is structurally lossy for this class of question.
--
-- Postgres won't let CREATE OR REPLACE change a function's return row type, so
-- each is dropped first, matching the pattern already used in
-- migrate_add_subject_to_retrieval_lanes.sql. Definitions otherwise copied
-- verbatim from the live functions -- only the new column is added.

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
  material_id uuid,
  subject text,
  source_page_images text[]
)
language sql stable
as $$
  select id, content, source, content_type, difficulty, material_id, subject, source_page_images
  from content_chunks
  order by embedding <=> query_embedding
  limit match_count;
$$;

drop function if exists match_teacher_materials(vector, int);

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
  subject text,
  similarity double precision,
  source_page_images text[]
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
    subject,
    1 - (embedding <=> query_embedding) as similarity,
    source_page_images
  from content_chunks
  where material_id is not null
  order by embedding <=> query_embedding
  limit match_count;
$$;

drop function if exists match_teacher_materials_lexical(text, int, double precision);

create or replace function match_teacher_materials_lexical(
  query_text text,
  match_count int default 12,
  min_term_idf double precision default 3.0
)
returns table (
  id uuid,
  content text,
  source text,
  content_type text,
  difficulty text,
  material_id uuid,
  subject text,
  rank double precision,
  matched_terms int,
  source_page_images text[]
)
language sql stable
as $$
  with
  qterms as (
    select distinct t.lexeme
    from unnest(to_tsvector('simple', query_text)) as t(lexeme, positions, weights)
  ),
  corpus as (
    select count(*)::double precision as n from content_chunks
  ),
  df as (
    select
      q.lexeme,
      (
        select count(*)::double precision
        from content_chunks c
        where c.content_tsv @@ ('''' || replace(q.lexeme, '''', '''''') || '''')::tsquery
      ) as df
    from qterms q
  ),
  scoring_terms as (
    select df.lexeme, ln(corpus.n / df.df) as idf
    from df cross join corpus
    where df.df > 0 and ln(corpus.n / df.df) >= min_term_idf
  ),
  matched as (
    select c.id, t.lexeme
    from content_chunks c,
         unnest(c.content_tsv) as t(lexeme, positions, weights)
    where c.material_id is not null
      and t.lexeme in (select lexeme from scoring_terms)
  ),
  scored as (
    select m.id, sum(st.idf) as score, count(*)::int as matched_terms
    from matched m
    join scoring_terms st on st.lexeme = m.lexeme
    group by m.id
  )
  select
    c.id,
    c.content,
    c.source,
    c.content_type,
    c.difficulty,
    c.material_id,
    c.subject,
    s.score as rank,
    s.matched_terms,
    c.source_page_images
  from scored s
  join content_chunks c on c.id = s.id
  order by s.score desc, c.id
  limit match_count;
$$;

drop function if exists match_past_year_by_exam(vector, int, text, smallint, text, text);

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
    case when query_embedding is null then 0 else 1 end,
    -- nulls last so a question with no printed number doesn't lead the set
    c.exam_question_no nulls last,
    c.embedding <=> query_embedding
  limit match_count;
$$;
