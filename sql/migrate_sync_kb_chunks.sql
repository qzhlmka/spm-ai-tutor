-- Keep kb_chunks in step with content_chunks for the rows Phase 4 CARRIED OVER
-- (sql/migrate_add_kb_chunks.sql, src/rag/carry-over.ts): teacher-upload
-- chunks and past-year questions. Production reads kb_chunks since 2026-10-13
-- (RETRIEVAL_BACKEND=kb_chunks), but every ingestion path still writes only to
-- content_chunks — the CLI ingester, teacher uploads (materials.ts), and the
-- bespoke past-year scripts that bypass runIngestion(). A trigger here covers
-- all of them, plus the edits made after insert: a teacher renaming a material
-- (subject/topic pushed down to its chunks), exam-label backfills, page-image
-- repairs, and deletes (a material is deleted chunks-first, so each chunk's
-- delete removes its kb_chunks copy).
--
-- Mapping is the carry-over's, so a synced row is indistinguishable from a
-- carried one:
--   origin       material_id set → carried_teacher; else past_year_question → carried_past_year
--   doc_id       source_file without ".pdf"; "(unattributed <subject>)" when null
--   page         from the first page image ("…/page-0012.png" → 12), else 0
--   language     more Malay than English function words → ms, else en
--   embedding    copied — same model (multilingual-e5-base), so comparable
-- Past-year questions from one of the rebuilt textbooks are NOT copied (the
-- carry-over skipped them too): that book's pages are already in kb_chunks as
-- origin 'textbook', so a copy would be the same text twice.
--
-- NOT covered: textbook/concept chunks from the CLI ingester. Those belong in
-- the rebuilt pipeline (page text, exact pages) rather than as LLM chunks;
-- re-run it for a new textbook.
--
-- Current drift (read-only check, 2026-10-13): 0 rows to back-fill outside
-- the rebuilt textbooks, 0 orphans. The back-fill at the bottom is idempotent
-- and expected to insert nothing; it is there for rows written between this
-- check and running this file.

create or replace function kb_sync_qualifies(c content_chunks) returns boolean
language sql stable set search_path = public as $$
  select c.embedding is not null
     and (
       c.material_id is not null
       or (
         c.content_type = 'past_year_question'
         and not exists (
           select 1 from kb_chunks k
           where k.origin = 'textbook'
             and k.doc_id = trim(regexp_replace(coalesce(c.source_file, ''), '\.pdf$', '', 'i'))
         )
       )
     )
$$;

create or replace function kb_sync_upsert(c content_chunks) returns void
language sql volatile set search_path = public, extensions as $$
  insert into kb_chunks (
    origin, doc_id, page, subject, language, content, embedding, content_type, topic, source,
    material_id, legacy_chunk_id, exam_year, exam_authority, exam_district, exam_set,
    exam_question_no, source_page_images
  ) values (
    case when c.material_id is not null then 'carried_teacher' else 'carried_past_year' end,
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

-- Fail-open: a sync error must never fail the content_chunks write itself
-- (that would turn a kb_chunks problem into a broken teacher upload or a
-- failed ingestion batch). The error is raised as a WARNING (Postgres logs)
-- and the row is simply missing from kb_chunks until re-synced — the
-- back-fill below finds exactly those rows.
create or replace function kb_sync_from_content_chunks() returns trigger
language plpgsql set search_path = public, extensions as $$
begin
  begin
    if tg_op = 'DELETE' then
      delete from kb_chunks where legacy_chunk_id = old.id;
    elsif kb_sync_qualifies(new) then
      perform kb_sync_upsert(new);
    elsif tg_op = 'UPDATE' then
      -- No longer qualifies (e.g. material_id cleared, retyped): drop the copy.
      delete from kb_chunks where legacy_chunk_id = old.id;
    end if;
  exception when others then
    raise warning 'kb_chunks sync failed for content_chunks %: %', coalesce(new.id, old.id), sqlerrm;
  end;
  return coalesce(new, old);
end $$;

drop trigger if exists content_chunks_kb_sync on content_chunks;
create trigger content_chunks_kb_sync
  after insert or update or delete on content_chunks
  for each row execute function kb_sync_from_content_chunks();

-- Back-fill (idempotent; expected 0 rows).
select kb_sync_upsert(c)
from content_chunks c
where kb_sync_qualifies(c)
  and not exists (select 1 from kb_chunks k where k.legacy_chunk_id = c.id);
