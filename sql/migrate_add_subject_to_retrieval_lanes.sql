-- Exposes content_chunks.subject from the three similarity lanes, so the
-- context block can label each chunk with the subject it belongs to.
--
-- WHY. The context block already labels every other attribute that changes how
-- a chunk should be treated -- content_type, whether it is this student's own
-- teacher's material, and (for the exam lane) which paper it came from. Subject
-- was the one distinguishing fact never passed through, and that gap was
-- load-bearing in a real failure: asked for a past-year example six turns into a
-- Chemistry conversation, the tutor handed over a Sejarah question under "here
-- is an example from your saved past-year questions". It was not being careless.
-- What it saw was a `past_year_question` whose only identifying line read
-- `Source: Perubahan Johor Bahru 2023`, which does not say "Sejarah" to anyone
-- who cannot see the row. The model could not have caught this even in
-- principle.
--
-- The real fix for that failure is retrieval-side (the subject predicate in
-- parseExamFilterFromQuestion / match_past_year_by_exam). This migration is the
-- second half: it makes a wrong-subject chunk VISIBLE to the model instead of
-- silent, so the failure mode degrades from confident substitution to a
-- correctable mistake. match_past_year_by_exam already returns subject.
--
-- Postgres will not let CREATE OR REPLACE change a function's return row type,
-- and adding a column counts as a change -- so each one is dropped first. The
-- signatures are unchanged, so nothing that calls these needs updating beyond
-- reading the new column.

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
  subject text
)
language sql stable
as $$
  select id, content, source, content_type, difficulty, material_id, subject
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
    subject,
    1 - (embedding <=> query_embedding) as similarity
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
  matched_terms int
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
    s.matched_terms
  from scored s
  join content_chunks c on c.id = s.id
  order by s.score desc, c.id
  limit match_count;
$$;
