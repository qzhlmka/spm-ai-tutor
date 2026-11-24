-- Structured exam identity for past-year questions, so a student can ask for a
-- specific paper ("past year maths johor 2023") and get an exact answer,
-- including an exact "no".
--
-- Parsed from the free-text `source` label by src/lib/exam-label.ts and written
-- by src/scripts/backfill-exam-labels.ts. Nothing upstream ever recorded the
-- exam: `source` is whatever the chunking model copied off a vision-OCR'd page,
-- in five different per-subject shapes, with the identifying word mangled
-- ("Percubaan" is stored six ways in Mathematics alone, and the commonest
-- variant "Perubahan" is an ordinary Malay word meaning "change").
--
-- These columns are deliberately NOT part of the embedded passage text. A
-- cosine match on "Johor 2023" is a similarity, not a predicate: it would still
-- return Selangor 2022 when Johor had nothing, silently, looking exactly like a
-- correct answer. An exact predicate can say "none", which is what a student
-- asking for a specific paper actually needs. Not embedding also means the
-- backfill needs no re-embedding of the ~2.5k affected rows.
alter table content_chunks
  add column if not exists exam_year smallint,
  add column if not exists exam_authority text,
  add column if not exists exam_district text,
  add column if not exists exam_set smallint,
  -- text, not integer: labels carry "S8" and "2(a)" as well as plain numbers,
  -- and coercing those into an integer is precisely how the Mathematics
  -- answer-key pairing went wrong (see CLAUDE.md).
  add column if not exists exam_question_no text;

-- Partial: only past-year rows ever carry an exam identity, and they are ~2.5k
-- of a much larger table.
create index if not exists content_chunks_exam_idx
  on content_chunks (subject, exam_year, exam_authority)
  where content_type = 'past_year_question';

-- Supports "what do you have for Johor?" without a year, and the coverage
-- summary the tutor is given when a requested paper is missing.
create index if not exists content_chunks_exam_authority_idx
  on content_chunks (exam_authority, exam_year)
  where content_type = 'past_year_question';

-- Bulk UPDATE for the backfill. PostgREST's .upsert() cannot be used: it
-- INSERTs first, so a partial column list fails the NOT NULL constraints on
-- columns the backfill has no business touching (exam_board, subject,
-- embedding...). A per-row .update() would be ~2.5k round trips.
create or replace function apply_exam_labels(labels jsonb)
returns integer
language plpgsql
as $$
declare
  updated integer;
begin
  update content_chunks c
  set exam_year        = l.exam_year,
      exam_authority   = l.exam_authority,
      exam_district    = l.exam_district,
      exam_set         = l.exam_set,
      exam_question_no = l.exam_question_no
  from jsonb_to_recordset(labels) as l(
    id uuid,
    exam_year smallint,
    exam_authority text,
    exam_district text,
    exam_set smallint,
    exam_question_no text
  )
  where c.id = l.id
    -- Belt and braces: this function exists only to label past-year questions,
    -- and an id list is not by itself a guarantee of that.
    and c.content_type = 'past_year_question';
  get diagnostics updated = row_count;
  return updated;
end;
$$;
