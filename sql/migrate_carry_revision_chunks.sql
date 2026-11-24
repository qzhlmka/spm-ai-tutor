-- Carry the revision books' notes and worked solutions into kb_chunks
-- (2026-10-20). Run in the Supabase SQL editor AFTER migrate_sync_kb_chunks.sql.
--
-- The 2026-10-13 cutover (src/rag/carry-over.ts) copied two groups from
-- content_chunks: teacher-upload chunks and past-year questions. Everything else
-- was assumed to be a textbook the new pipeline had rebuilt. It was not: the
-- revision books also hold concept notes and worked solutions, and those fell
-- through the gap, so production has not seen them since the cutover:
--
--   SEJARAH SKEMA SELEKOH 2024 F4 / F5        343  (essay answer points, worked questions)
--   CHEMISTRY - BUKU SELEKOH AKHIR SPM 2024     83  (worked questions, notes)
--   MATEMATIK _ BUKU SELEKOH AKHIR SPM 2024     19  (worked questions)
--
-- 445 rows, counted read-only before writing this file. They get their own
-- origin, 'carried_revision', rather than borrowing one: 'carried_teacher'
-- would label them as the student's teacher's material (the prompt treats that
-- as authoritative), and 'textbook' would make the textbook-figure locator
-- treat their page images as textbook pages. kb_in_lane('main') is
-- `origin <> 'carried_past_year'`, so they join the main lane with no change
-- to the search functions. Vectors are copied (same model), nothing is
-- re-embedded, and no existing row is touched.
--
-- Old textbook chunks are still excluded: a row qualifies only when its
-- source_file is set and is NOT one of the rebuilt textbooks, whose pages are
-- already in kb_chunks as origin 'textbook'.

alter table kb_chunks drop constraint if exists kb_chunks_origin_check;
alter table kb_chunks add constraint kb_chunks_origin_check
  check (origin in ('textbook', 'carried_teacher', 'carried_past_year', 'carried_revision'));

create or replace function kb_sync_qualifies(c content_chunks) returns boolean
language sql stable set search_path = public as $$
  select c.embedding is not null
     and (
       c.material_id is not null
       or (
         nullif(trim(coalesce(c.source_file, '')), '') is not null
         and not exists (
           select 1 from kb_chunks k
           where k.origin = 'textbook'
             and k.doc_id = trim(regexp_replace(c.source_file, '\.pdf$', '', 'i'))
         )
       )
       -- Past-year rows with no source_file were carried before; keep them.
       or (c.content_type = 'past_year_question' and nullif(trim(coalesce(c.source_file, '')), '') is null)
     )
$$;

create or replace function kb_sync_upsert(c content_chunks) returns void
language sql volatile set search_path = public, extensions as $$
  insert into kb_chunks (
    origin, doc_id, page, subject, language, content, embedding, content_type, topic, source,
    material_id, legacy_chunk_id, exam_year, exam_authority, exam_district, exam_set,
    exam_question_no, source_page_images
  ) values (
    case
      when c.material_id is not null then 'carried_teacher'
      when c.content_type = 'past_year_question' then 'carried_past_year'
      else 'carried_revision'
    end,
    coalesce(nullif(trim(regexp_replace(coalesce(c.source_file, ''), '\.pdf$', '', 'i')), ''), '(unattributed ' || coalesce(c.subject, 'unknown') || ')'),
    coalesce(substring(c.source_page_images[1] from '(\d+)\.png$')::int, 0),
    c.subject,
    case when regexp_count(c.content, '\m(yang|dan|ialah|adalah|bagi|dengan|untuk|dalam|tidak|soalan|jawapan)\M', 1, 'i')
            > regexp_count(c.content, '\m(the|and|is|of|which|with|for|in|not|question|answer)\M', 1, 'i')
         then 'ms' else 'en' end,
    c.content, c.embedding, c.content_type, c.topic, c.source,
    c.material_id, c.id, c.exam_year, c.exam_authority, c.exam_district, c.exam_set,
    c.exam_question_no, c.source_page_images
  )
  on conflict (legacy_chunk_id) where legacy_chunk_id is not null do update set
    origin = excluded.origin, doc_id = excluded.doc_id, page = excluded.page,
    subject = excluded.subject, language = excluded.language, content = excluded.content,
    embedding = excluded.embedding, content_type = excluded.content_type, topic = excluded.topic,
    source = excluded.source, material_id = excluded.material_id,
    exam_year = excluded.exam_year, exam_authority = excluded.exam_authority,
    exam_district = excluded.exam_district, exam_set = excluded.exam_set,
    exam_question_no = excluded.exam_question_no, source_page_images = excluded.source_page_images
$$;

-- Back-fill (idempotent). Expected: 445 rows.
select count(*) as carried
from (
  select kb_sync_upsert(c)
  from content_chunks c
  where kb_sync_qualifies(c)
    and not exists (select 1 from kb_chunks k where k.legacy_chunk_id = c.id)
) s;

-- Check: expect carried_revision = 445, and the other origins unchanged
-- (textbook 10165, carried_teacher 1384, carried_past_year 2107).
select origin, count(*) from kb_chunks group by origin order by origin;
