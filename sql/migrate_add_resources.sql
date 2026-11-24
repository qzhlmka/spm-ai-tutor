-- Teacher-curated external links (revision videos, past-paper sites, interactive
-- simulations). Teachers asked for this directly during user testing: they had a
-- set of titled YouTube revision links organised by subject and no way to give
-- them to students, because everything a teacher could contribute had to be a PDF
-- that got chunked into the RAG knowledge base.
--
-- Deliberately NOT part of content_chunks / the retrieval path. A link has no
-- ingestible text of its own — embedding a title and a URL would put a near-empty
-- chunk into whole-KB cosine search, competing for the same 12-chunk context
-- budget as real teaching content. This is a plain browsable catalogue instead.
create table if not exists resources (
  id uuid primary key default gen_random_uuid(),
  -- `on delete set null` mirrors materials.uploaded_by: a deactivated teacher's
  -- links stay useful to the students already relying on them, they just lose
  -- the attribution (the UI falls back to "Unknown teacher").
  uploaded_by uuid references users(id) on delete set null,
  title text not null,
  url text not null,
  subject text not null,
  -- Nullable, unlike materials.topic: a teacher pasting a batch of links often
  -- knows the subject but not a single topic that fits ("general revision
  -- channel"), and forcing one produces junk topics that fragment the grouping.
  topic text,
  description text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- The only query the student-facing list runs is "everything, grouped by subject
-- then topic, newest first" (see listResources) — there's no per-subject filter
-- at the SQL level because the catalogue is small enough to filter client-side,
-- the way the materials library already does.
create index if not exists resources_subject_topic_idx on resources (subject, topic);

-- Backs the ownership scoping on update/delete, which always filter
-- `uploaded_by = <caller>` alongside the id.
create index if not exists resources_uploaded_by_idx on resources (uploaded_by, created_at desc);
