-- Run this ONLY after `npm run reembed` has backfilled embedding_e5 for
-- every row in content_chunks (verify with the query below before running).
--
--   select count(*) from content_chunks where embedding_e5 is null;
--   -- must return 0
--
-- Swaps the old gte-base embedding column out for the new
-- multilingual-e5-base one. Both are vector(768), so match_content_chunks'
-- signature doesn't need to change — only the data underneath it does.

drop index if exists content_chunks_embedding_idx;

alter table content_chunks drop column embedding;
alter table content_chunks rename column embedding_e5 to embedding;

create index content_chunks_embedding_idx
  on content_chunks using hnsw (embedding vector_cosine_ops);
