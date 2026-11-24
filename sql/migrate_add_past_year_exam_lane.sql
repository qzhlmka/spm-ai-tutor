-- Retrieval lane for "give me Johor 2023 maths questions". Requires
-- sql/migrate_add_exam_labels.sql.
--
-- Unlike every other lane in chat-handler.ts this one is a FILTER first and a
-- similarity second. The where-clause decides membership; the embedding only
-- orders what is already inside it. That ordering still matters -- "matrix
-- questions from Johor 2023" should lead with matrices -- but it can never add
-- a row from another state or year, which is the whole point. Pass a null
-- embedding to get a stable order by question number instead.
--
-- Every filter argument is nullable and a null means "don't filter on this", so
-- one function serves "Johor 2023", "anything from 2022", and "everything
-- Johor has".
create or replace function match_past_year_by_exam(
  query_embedding vector(768) default null,
  match_count integer default 12,
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
  exam_question_no text
)
language sql
stable
as $$
  select c.id, c.content, c.source, c.content_type, c.difficulty, c.material_id,
         c.subject, c.topic, c.exam_year, c.exam_authority, c.exam_district,
         c.exam_question_no
  from content_chunks c
  where c.content_type = 'past_year_question'
    and (p_subject   is null or c.subject        = p_subject)
    and (p_year      is null or c.exam_year      = p_year)
    and (p_authority is null or c.exam_authority = p_authority)
    and (p_district  is null or c.exam_district  = p_district)
  order by
    case when query_embedding is null then 0 else 1 end,
    c.exam_question_no nulls last,
    c.embedding <=> query_embedding
  limit match_count;
$$;

-- Coverage summary: what this knowledge base actually holds, so the tutor can
-- say "I have Johor 2021-2023 but not 2013" instead of a bare "no" -- which a
-- student cannot distinguish from a broken app. It is also the guard against
-- inventing coverage: the prompt is told these are the only years it may claim.
create or replace function past_year_exam_coverage(p_subject text default null)
returns table (subject text, exam_authority text, exam_year smallint, question_count bigint)
language sql
stable
as $$
  select c.subject, c.exam_authority, c.exam_year, count(*) as question_count
  from content_chunks c
  where c.content_type = 'past_year_question'
    and c.exam_authority is not null
    and c.exam_year is not null
    and (p_subject is null or c.subject = p_subject)
  group by c.subject, c.exam_authority, c.exam_year
  order by c.subject, c.exam_authority, c.exam_year desc;
$$;
