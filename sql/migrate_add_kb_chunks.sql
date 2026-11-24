-- Phase 4 of the RAG rebuild (RAG_STATUS.md): the new knowledge-base table,
-- built NEXT TO content_chunks, never written into it. The live app keeps
-- reading content_chunks until cutover; this migration only adds objects.
--
-- Rows come from two places (src/rag/load-kb.ts):
--   origin 'textbook'          16 textbooks rebuilt by the new pipeline: page
--                              text layer (glyph-repaired) or OCR cache, front/
--                              back matter dropped, recursive 1000/150 split per
--                              page — every row has an exact physical page.
--   origin 'carried_teacher'   live teacher-upload chunks, copied with their
--   origin 'carried_past_year' vectors, exam labels, page images and material
--                              link. page = 0 when the live row never recorded one.
--
-- Search is hybrid — vector + BM25 keyword, fused by reciprocal rank — because
-- that is what passed Phase 3 on the pilot (hybrid.ts). Past-year questions are
-- a lane of their own: mixed into the main ranking they took rank 1 on concept
-- questions and failed the Phase 4 scale check (MRR −0.051); kept apart it
-- passed (R@5 0.851, MRR 0.756 on the 47 pilot items).

create table if not exists kb_chunks (
  id bigint generated always as identity primary key,
  origin text not null check (origin in ('textbook', 'carried_teacher', 'carried_past_year')),
  doc_id text not null,
  page int not null default 0,
  subject text,
  language text,
  content text not null,
  embedding vector(768) not null,
  content_tsv tsvector generated always as (to_tsvector('simple', content)) stored,
  -- Token count of content_tsv (sum of positions), the BM25 document length. Set by trigger.
  token_count int not null default 0,
  content_type text,
  topic text,
  source text,
  material_id uuid references materials(id) on delete cascade,
  legacy_chunk_id uuid,
  exam_year int2,
  exam_authority text,
  exam_district text,
  exam_set int2,
  exam_question_no text,
  source_page_images text[],
  created_at timestamptz not null default now()
);

alter table kb_chunks enable row level security;  -- service role only, like content_chunks

create index if not exists kb_chunks_embedding_hnsw on kb_chunks using hnsw (embedding vector_cosine_ops);
create index if not exists kb_chunks_tsv_gin on kb_chunks using gin (content_tsv);
create index if not exists kb_chunks_origin_idx on kb_chunks (origin);
create index if not exists kb_chunks_doc_page_idx on kb_chunks (doc_id, page);
create index if not exists kb_chunks_material_idx on kb_chunks (material_id) where material_id is not null;
create unique index if not exists kb_chunks_legacy_idx on kb_chunks (legacy_chunk_id) where legacy_chunk_id is not null;

create or replace function kb_chunks_set_token_count() returns trigger
language plpgsql set search_path = public, extensions as $$
begin
  new.token_count := coalesce((
    select sum(coalesce(array_length(t.positions, 1), 1))
    from unnest(to_tsvector('simple', new.content)) as t(lexeme, positions, weights)
  ), 0);
  return new;
end $$;

drop trigger if exists kb_chunks_token_count on kb_chunks;
create trigger kb_chunks_token_count before insert or update of content on kb_chunks
  for each row execute function kb_chunks_set_token_count();

-- Which rows a lane searches.
create or replace function kb_in_lane(origin text, lane text) returns boolean
language sql immutable set search_path = public as $$
  select case lane
    when 'main' then origin <> 'carried_past_year'
    when 'teacher' then origin = 'carried_teacher'
    when 'past_year' then origin = 'carried_past_year'
    when 'all' then true
    else false
  end
$$;

-- BM25 over content_tsv (k1 1.2, b 0.75, IDF over the whole table), the same
-- scoring as the pilot's in-memory lane. Terms in more than half the rows are
-- left out: they score ~0 and would make every row a candidate.
create or replace function kb_keyword_search(query_text text, lane text default 'main', match_count int default 50)
returns table (id bigint, score double precision)
language sql stable set search_path = public, extensions as $$
  with
  stats as (select count(*)::float8 as n, greatest(avg(token_count), 1)::float8 as avgdl from kb_chunks),
  qterms as (select distinct t.lexeme from unnest(to_tsvector('simple', query_text)) as t(lexeme, positions, weights)),
  df as (
    select q.lexeme,
           (select count(*) from kb_chunks c where c.content_tsv @@ ('''' || replace(q.lexeme, '''', '''''') || '''')::tsquery)::float8 as df
    from qterms q
  ),
  idf as (
    select df.lexeme, ln(1 + (stats.n - df.df + 0.5) / (df.df + 0.5)) as idf
    from df cross join stats
    where df.df > 0 and df.df <= stats.n * 0.5
  ),
  tsq as (select string_agg('''' || replace(lexeme, '''', '''''') || '''', ' | ')::tsquery as q from idf),
  cand as (
    select c.id, c.token_count, c.content_tsv
    from kb_chunks c, tsq
    where tsq.q is not null and c.content_tsv @@ tsq.q and kb_in_lane(c.origin, lane)
  ),
  tf as (
    select cand.id, cand.token_count, t.lexeme, coalesce(array_length(t.positions, 1), 1)::float8 as tf
    from cand, unnest(cand.content_tsv) as t(lexeme, positions, weights)
    where t.lexeme in (select lexeme from idf)
  )
  select tf.id, sum(idf.idf * (tf.tf * 2.2) / (tf.tf + 1.2 * (0.25 + 0.75 * tf.token_count / stats.avgdl))) as score
  from tf join idf using (lexeme) cross join stats
  group by tf.id
  order by score desc
  limit match_count
$$;

-- Hybrid search: vector top-N and BM25 top-N in the lane, fused by RRF (k = 60).
create or replace function kb_search(
  query_embedding vector(768),
  query_text text,
  lane text default 'main',
  match_count int default 12,
  lane_depth int default 50
)
returns table (
  id bigint, origin text, doc_id text, page int, subject text, language text, content text,
  content_type text, topic text, source text, material_id uuid,
  exam_year int2, exam_authority text, exam_district text, exam_set int2, exam_question_no text,
  source_page_images text[], similarity double precision, vector_rank int, keyword_rank int, rrf_score double precision
)
language sql stable
set search_path = public, extensions
set hnsw.iterative_scan = 'relaxed_order'
set hnsw.ef_search = 100
as $$
  with
  vec as materialized (
    select c.id, 1 - (c.embedding <=> query_embedding) as similarity
    from kb_chunks c
    where kb_in_lane(c.origin, lane)
    order by c.embedding <=> query_embedding
    limit lane_depth
  ),
  vranked as (select v.id, v.similarity, row_number() over (order by v.similarity desc)::int as r from vec v),
  kw as (select k.id, row_number() over (order by k.score desc)::int as r from kb_keyword_search(query_text, lane, lane_depth) k),
  fused as (
    select coalesce(v.id, k.id) as id, v.similarity, v.r as vector_rank, k.r as keyword_rank,
           coalesce(1.0 / (60 + v.r), 0) + coalesce(1.0 / (60 + k.r), 0) as rrf_score
    from vranked v full outer join kw k on k.id = v.id
  )
  select c.id, c.origin, c.doc_id, c.page, c.subject, c.language, c.content,
         c.content_type, c.topic, c.source, c.material_id,
         c.exam_year, c.exam_authority, c.exam_district, c.exam_set, c.exam_question_no,
         c.source_page_images, f.similarity, f.vector_rank, f.keyword_rank, f.rrf_score
  from fused f join kb_chunks c on c.id = f.id
  order by f.rrf_score desc
  limit match_count
$$;
