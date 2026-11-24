-- Migration: switch content_chunks.embedding from OpenAI text-embedding-3-small
-- (1536 dims) to gte-base, run locally in-process via src/lib/embeddings.ts (768 dims).
--
-- content_chunks already had 861 rows embedded with the old model at the time
-- this migration was written. OpenAI and gte-base vectors are NOT comparable —
-- mixing them silently returns wrong retrieval results with no error. So this
-- runs in two steps instead of a plain `alter column ... type vector(768)`:
--
--   1. (this file) Add a new nullable `embedding_768` column alongside the
--      existing `embedding` column. Nothing is dropped yet.
--   2. Run `npm run reembed` (src/scripts/reembed.ts) to backfill
--      `embedding_768` for every existing row via the local embed().
--   3. Once `reembed` reports 0 remaining NULLs, run migrate_gte_base_finish.sql
--      to drop the old column, rename embedding_768 -> embedding, rebuild the
--      HNSW index, and update match_content_chunks to vector(768).
--
-- If content_chunks is empty in your environment (fresh project, nothing
-- ingested yet), you can skip this two-step dance and just run
-- migrate_gte_base_finish.sql directly against the vector(1536) column.

alter table content_chunks
  add column if not exists embedding_768 vector(768);
