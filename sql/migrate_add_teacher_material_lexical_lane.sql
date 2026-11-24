-- Lexical (keyword) retrieval lane for teacher-uploaded material.
--
-- WHY THIS EXISTS
-- match_teacher_materials is a dense-vector search (multilingual-e5). Dense
-- embeddings match on MEANING, and they deliberately don't reward literal
-- string overlap — which is exactly backwards for the case where a student
-- quotes their teacher's own wording back at us.
--
-- Measured on the real KB: a teacher's naming-prefix mnemonic ("Tips untuk
-- mengingat: 1 mama, 2 eat, 3 papaya, 4 but, 5 papa, 6 has, 7 his, 8 orange,
-- 9 next, 10 door") scores only 0.7440 against "what does mama eat papaya
-- mean" — under the 0.81 relevance cutoff, so the tutor never sees it. Every
-- one of those words is literally in the chunk; e5 just has no chemistry
-- meaning to latch onto in "mama eat papaya", so semantically it reads as
-- unrelated. Dropping the vector cutoff to 0.74 to catch it would drag in the
-- genuinely unrelated chunks sitting at 0.75-0.80.
--
-- Keyword search has the opposite bias, so it covers precisely this gap: a
-- student quoting a teacher-specific mnemonic, term, shorthand, or notation
-- matches on the words themselves. The two lanes are merged in
-- chat-handler.ts; neither replaces the other.
--
-- WHY NOT ts_rank
-- The obvious implementation — OR-joined plainto_tsquery + ts_rank — was built
-- first and measured, and it does not work. Postgres FTS has no IDF, so
-- ts_rank scores a match on a common word the same way it scores a rare one.
-- Over 8 relevant + 8 irrelevant probe queries the two sets overlapped
-- completely: "what is the quadratic formula" scored 0.05606 (matching only the
-- word "formula") while the actual mnemonic query "what does mama eat papaya
-- mean" scored 0.03040. No cutoff on ts_rank can separate those.
--
-- So this function scores IDF explicitly: each distinct query lexeme that hits
-- a chunk contributes ln(N / df), where df is how many chunks contain that
-- lexeme. Matching several distinctive words therefore far outranks matching
-- one common one, which is the behaviour the lane needs and ts_rank lacks.
--
-- WHY df IS MEASURED OVER THE WHOLE KNOWLEDGE BASE, NOT THE TEACHER SUBSET
-- The search is restricted to teacher chunks, but the corpus STATISTICS must
-- not be. Scoring df over only the ~38 teacher chunks was built and measured
-- first, and it fails for a non-obvious reason: teacher material is mostly
-- Malay, so English function words ("the", "of", "for", "is") appear in just a
-- handful of those chunks and IDF therefore rates them as highly distinctive.
-- "what is the formula for kinetic energy" scored 8.07865 that way — above the
-- genuinely relevant "explain siri homolog" at 2.67000. Measuring df across all
-- of content_chunks instead gives those words their real frequency, so they
-- contribute almost nothing, while a word like "papaya" (one chunk in
-- thousands) contributes a lot.
--
-- WHY THERE IS A PER-TERM IDF FLOOR
-- Whole-KB IDF still wasn't enough on its own, for the same language-imbalance
-- reason one level up: the knowledge base is largely Malay, so English question
-- words are genuinely uncommon in it and IDF rated them as content-bearing.
-- "what" has df 466 of 4274 -> idf 2.835, almost the same as "formula" (2.863),
-- so "what is the formula for kinetic energy" scored 8.87380 — close enough to
-- the genuinely relevant "explain siri homolog" (10.16688) that no cutoff sat
-- safely between them.
-- Requiring each term to clear min_term_idf before it can contribute at all
-- fixes this in any language: a word that is common in the corpus is ignored
-- whether it is English or Malay, and only distinctive terms score. With the
-- floor at 3.0, all 8 irrelevant probe queries return ZERO rows (not merely a
-- low score), and 18 realistic but unrelated SPM questions produce exactly one
-- hit — "homologous chromosome", against a bilingual chunk that really does
-- contain "homologous series".
--
-- KNOWN LIMITATION
-- This is bag-of-words: it cannot distinguish a student quoting the mnemonic
-- from one incidentally reusing its ordinary words. "my papa has a door" scores
-- 16.0, above genuine queries at 10.2. That is why chat-handler.ts feeds this
-- lane's hits into the context but never lets them drive the teacher-material
-- download chip. Fixing it properly would need phrase/adjacency scoring.
--
-- 'simple' config (not 'english'): the corpus is mixed Malay/English. An
-- English stemmer mangles Malay tokens while removing none of its stopwords.
-- 'simple' just lowercases and splits, which is honest for both languages —
-- and IDF weighting handles stopwords better than a stopword list anyway,
-- since a word common in THIS corpus is down-weighted whatever language it is.

-- Stored generated column so the lane never recomputes tsvectors at query
-- time. The two-argument to_tsvector(regconfig, text) is immutable, which is
-- what makes it legal as a generated column (the one-argument form is not).
alter table content_chunks
  add column if not exists content_tsv tsvector
  generated always as (to_tsvector('simple', content)) stored;

-- Partial GIN index over exactly the subset this lane searches, so it doesn't
-- degrade into a sequential scan as teacher uploads accumulate.
create index if not exists content_chunks_material_tsv_idx
  on content_chunks using gin (content_tsv)
  where material_id is not null;

-- Full-table GIN index, used only for the per-lexeme document-frequency counts
-- (see WHY df IS MEASURED OVER THE WHOLE KNOWLEDGE BASE above). Without it each
-- df count is a sequential scan of every chunk.
create index if not exists content_chunks_tsv_idx
  on content_chunks using gin (content_tsv);

-- Supersedes the on-the-fly expression index from this migration's first
-- version; content_tsv + its index above cover the same ground.
drop index if exists content_chunks_material_content_fts_idx;

-- NOTE: if an older 2-argument version of this function exists, drop it first —
-- `create or replace` with a new parameter creates an OVERLOAD rather than
-- replacing, and PostgREST then refuses the call with PGRST203 (ambiguous).
drop function if exists match_teacher_materials_lexical(text, int);

create or replace function match_teacher_materials_lexical(
  query_text text,
  match_count int default 12,
  min_term_idf double precision default 3.0
)
returns table (
  id uuid,
  content text,
  source text,
  content_type text,
  difficulty text,
  material_id uuid,
  rank double precision,
  matched_terms int
)
language sql stable
as $$
  with
  -- Distinct lexemes of the student's question.
  qterms as (
    select distinct t.lexeme
    from unnest(to_tsvector('simple', query_text)) as t(lexeme, positions, weights)
  ),
  corpus as (
    select count(*)::double precision as n from content_chunks
  ),
  -- Document frequency per query lexeme across the WHOLE knowledge base. Each
  -- count is a single GIN index probe (content_chunks_tsv_idx); the lexeme is
  -- wrapped in single quotes and internal quotes doubled so it becomes one
  -- literal tsquery term and can't be reparsed as tsquery syntax.
  df as (
    select
      q.lexeme,
      (
        select count(*)::double precision
        from content_chunks c
        where c.content_tsv @@ ('''' || replace(q.lexeme, '''', '''''') || '''')::tsquery
      ) as df
    from qterms q
  ),
  -- Only terms distinctive enough to be evidence of a real content match.
  scoring_terms as (
    select df.lexeme, ln(corpus.n / df.df) as idf
    from df cross join corpus
    where df.df > 0 and ln(corpus.n / df.df) >= min_term_idf
  ),
  -- Matched (teacher chunk, scoring term) pairs.
  matched as (
    select c.id, t.lexeme
    from content_chunks c,
         unnest(c.content_tsv) as t(lexeme, positions, weights)
    where c.material_id is not null
      and t.lexeme in (select lexeme from scoring_terms)
  ),
  scored as (
    select m.id, sum(st.idf) as score, count(*)::int as matched_terms
    from matched m
    join scoring_terms st on st.lexeme = m.lexeme
    group by m.id
  )
  select
    c.id,
    c.content,
    c.source,
    c.content_type,
    c.difficulty,
    c.material_id,
    s.score as rank,
    s.matched_terms
  from scored s
  join content_chunks c on c.id = s.id
  order by s.score desc, c.id
  limit match_count;
$$;
