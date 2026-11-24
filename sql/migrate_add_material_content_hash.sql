-- Dedupe guard for teacher material uploads. Nothing previously stopped a
-- teacher re-uploading the same PDF (e.g. after a failed attempt, or by
-- accident) from creating a second `materials` row and a second full set of
-- `content_chunks` for identical content — this happened for real (a GTL
-- deck ingested twice, six weeks apart, both surviving in retrieval and
-- competing for the same 12-chunk context budget). uploadMaterial() now
-- hashes the raw file bytes (sha256) and rejects a re-upload that matches an
-- existing successful upload from the same teacher, rather than silently
-- duplicating.
alter table materials add column if not exists content_hash text;

create index if not exists materials_uploaded_by_hash_idx
  on materials (uploaded_by, content_hash)
  where status = 'done';
