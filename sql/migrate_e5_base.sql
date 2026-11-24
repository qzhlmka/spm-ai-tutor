-- Migration: switch content_chunks.embedding from gte-base to
-- multilingual-e5-base. Both are 768 dims, so this is NOT a column type
-- change — but the vectors are still not comparable to each other (different
-- model, and E5 requires "query: "/"passage: " prefixed input), so mixing
-- them in one column mid-migration would silently corrupt retrieval same as
-- any other model swap. Two-step dance again, just like the gte-base move:
--
--   1. (this file) Add a new nullable `embedding_e5` column. Nothing dropped.
--   2. Run `npm run reembed` (src/scripts/reembed.ts) to backfill
--      `embedding_e5` for every existing row via embedPassage().
--   3. Once `reembed` reports 0 remaining NULLs, run
--      migrate_e5_base_finish.sql to drop the old column, rename
--      embedding_e5 -> embedding, and rebuild the HNSW index (RPC signature
--      is unchanged — still vector(768)).

alter table content_chunks
  add column if not exists embedding_e5 vector(768);
