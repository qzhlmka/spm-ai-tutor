-- Records which source PDF each chunk came from.
--
-- Until now nothing in content_chunks pointed back at a file: `source` is an
-- LLM-authored note ("Example 4"), and material_id only exists for uploads made
-- through the teacher portal. CLI-ingested content had no provenance at all,
-- which made "is this PDF already in the knowledge base?" unanswerable by
-- lookup — an audit of a 186-file folder had to fall back on content matching,
-- and every method tried (cosine similarity, exact and indexed phrase search)
-- failed calibration against files whose status was known. Vision-OCR'd content
-- is the specific killer: the stored text is the transcription, never the
-- source's own wording, so no text comparison can recognise it.
--
-- Nullable because the ~7,900 rows that predate this column genuinely cannot be
-- attributed after the fact. Backfilling them with a guess would be worse than
-- leaving the gap visible.
alter table content_chunks add column if not exists source_file text;

-- Supports the two queries this exists for: "what came from this file" and the
-- resumability check in the bulk note ingester ("which files are already done").
create index if not exists content_chunks_source_file_idx
  on content_chunks (source_file)
  where source_file is not null;
