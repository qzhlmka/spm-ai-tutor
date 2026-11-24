-- Fix for kb_keyword_search (sql/migrate_add_kb_chunks.sql): it hit Supabase's
-- 8 s statement timeout on every query. EXPLAIN ANALYZE on "what is ohm's law"
-- showed why: the planner estimated 1 row for the term list and the candidate
-- set (actual: 5 terms, 5,334 chunks), so it nested the candidate scan inside
-- the term loop — the bitmap scan ran 25 times and unnest(content_tsv) ran
-- 133,350 times instead of 5,334. 9,391 ms.
--
-- Materializing each step forces it to be computed once. Same query: 512 ms.
-- Same scoring (BM25, k1 1.2, b 0.75); only the plan shape changes.

create or replace function kb_keyword_search(query_text text, lane text default 'main', match_count int default 50)
returns table (id bigint, score double precision)
language sql stable set search_path = public, extensions as $$
  with
  stats as materialized (select count(*)::float8 as n, greatest(avg(token_count), 1)::float8 as avgdl from kb_chunks),
  qterms as materialized (select distinct t.lexeme from unnest(to_tsvector('simple', query_text)) as t(lexeme, positions, weights)),
  idf as materialized (
    select d.lexeme, ln(1 + (s.n - d.df + 0.5) / (d.df + 0.5)) as idf
    from (
      select q.lexeme,
             (select count(*) from kb_chunks c where c.content_tsv @@ ('''' || replace(q.lexeme, '''', '''''') || '''')::tsquery)::float8 as df
      from qterms q
    ) d cross join stats s
    where d.df > 0 and d.df <= s.n * 0.5
  ),
  tsq as materialized (select string_agg('''' || replace(lexeme, '''', '''''') || '''', ' | ')::tsquery as q from idf),
  cand as materialized (
    select c.id, c.token_count, c.content_tsv
    from kb_chunks c
    where c.content_tsv @@ (select q from tsq) and kb_in_lane(c.origin, lane)
  ),
  tf as materialized (
    select cand.id, cand.token_count, t.lexeme, coalesce(array_length(t.positions, 1), 1)::float8 as tf
    from cand cross join lateral unnest(cand.content_tsv) as t(lexeme, positions, weights)
    join idf on idf.lexeme = t.lexeme
  )
  select tf.id, sum(idf.idf * (tf.tf * 2.2) / (tf.tf + 1.2 * (0.25 + 0.75 * tf.token_count / s.avgdl))) as score
  from tf join idf using (lexeme) cross join stats s
  group by tf.id
  order by score desc
  limit match_count
$$;
