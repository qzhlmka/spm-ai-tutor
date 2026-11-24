-- Study Assistant Platform — base schema
-- RAG knowledge base + minimal chat history (no billing/dashboard tables — deferred)

create extension if not exists vector;
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Knowledge base
-- ---------------------------------------------------------------------------

create table content_chunks (
  id uuid primary key default gen_random_uuid(),
  exam_board text not null,
  subject text not null,
  topic text not null,
  subtopic text,
  content_type text not null,  -- 'concept' | 'worked_example' | 'past_year_question' | 'formula' | 'common_mistake'
  difficulty text,             -- 'easy' | 'medium' | 'hard'
  content text not null,
  source text,
  -- Originating PDF basename (migrate_add_chunk_source_file.sql). Null on rows
  -- ingested before that column existed.
  source_file text,
  -- Structured exam identity for past_year_question rows, parsed from `source`
  -- (migrate_add_exam_labels.sql). Not part of the embedded passage text.
  exam_year smallint,
  exam_authority text,
  exam_district text,
  exam_set smallint,
  exam_question_no text,
  embedding vector(768),       -- 768 dims = multilingual-e5-base (see src/lib/embeddings.ts)
  created_at timestamptz default now()
);

create index content_chunks_embedding_idx
  on content_chunks using hnsw (embedding vector_cosine_ops);

create index content_chunks_subject_topic_idx
  on content_chunks (subject, topic);

create index content_chunks_content_type_idx
  on content_chunks (content_type);

-- ---------------------------------------------------------------------------
-- Identity + chat history
-- users.id IS the Supabase Auth user id (auth.users.id) — login identity is
-- the conversation owner directly, no separate mapping table. Shared across
-- web + Telegram once a student's telegram_id is linked to the same row;
-- `channel` on messages tags which surface a message came from for analytics.
-- ---------------------------------------------------------------------------

create table users (
  id uuid primary key references auth.users(id) on delete cascade,
  telegram_id text unique,
  email text unique,
  display_name text,
  avatar_url text,
  role text not null default 'student', -- 'student' | 'teacher' — gates the material-upload UI, see src/lib/auth.ts
  created_at timestamptz default now()
);

-- Public bucket for profile pictures — uploads go through the backend's
-- service_role client (src/lib/profile.ts), which bypasses storage RLS, so no
-- storage.objects policies are needed for the write path. Public read is
-- inherent to a public bucket.
insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Teacher-uploaded materials
-- One row per upload via the teacher upload UI (src/lib/materials.ts) — tracks
-- status/provenance for content_chunks.material_id. Nullable FK on
-- content_chunks so pre-existing CLI-ingested chunks (material_id null) are
-- unaffected.
-- ---------------------------------------------------------------------------

create table materials (
  id uuid primary key default gen_random_uuid(),
  uploaded_by uuid references users(id) on delete set null,
  filename text not null,
  exam_board text not null,
  subject text not null,
  topic text not null,
  chunk_count int not null default 0,
  status text not null default 'processing', -- 'processing' | 'done' | 'failed'
  error text,
  -- Storage path for the original uploaded file (materials bucket, private —
  -- see migrate_add_material_file_storage.sql), so students can download the
  -- source document, not just ask the tutor about its content.
  file_path text,
  created_at timestamptz default now()
);

create index materials_uploaded_by_idx on materials (uploaded_by, created_at desc);

alter table content_chunks add column if not exists material_id uuid references materials(id) on delete set null;

-- Private bucket for the original uploaded files — see
-- migrate_add_material_file_storage.sql for why this isn't public like avatars.
insert into storage.buckets (id, name, public)
values ('materials', 'materials', false)
on conflict (id) do nothing;

create table conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  subject text,
  title text,
  starred boolean not null default false,
  updated_at timestamptz default now(),
  -- Chosen LLM provider; null = DEFAULT_PROVIDER (migrate_add_conversation_provider.sql).
  provider text,
  created_at timestamptz default now()
);

create index conversations_user_updated_idx on conversations (user_id, starred desc, updated_at desc);

create table messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  role text not null,       -- 'user' | 'assistant'
  channel text not null,    -- 'web' | 'telegram'
  content text not null,
  created_at timestamptz default now()
);

create index messages_conversation_idx on messages (conversation_id, created_at);

-- Student-uploaded chat attachments (image/PDF) — stored so the thumbnail/chip
-- in a chat bubble survives a page refresh or server restart, unlike the
-- transient base64 payload used for the single Anthropic request that answers
-- it. Private bucket + signed URLs, same pattern as `materials`.
insert into storage.buckets (id, name, public)
values ('chat-attachments', 'chat-attachments', false)
on conflict (id) do nothing;

create table message_attachments (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references messages(id) on delete cascade,
  filename text not null,
  mime_type text not null,
  storage_path text not null,
  created_at timestamptz default now()
);

create index message_attachments_message_idx on message_attachments (message_id);

-- ---------------------------------------------------------------------------
-- Per-student daily usage cap — see src/lib/usage.ts. Only enforced for
-- role = 'student'; teachers are exempt (see checkUsageLimit).
-- ---------------------------------------------------------------------------

create table usage_daily (
  user_id uuid not null references users(id) on delete cascade,
  usage_date date not null,
  cost_usd numeric(10, 6) not null default 0,
  primary key (user_id, usage_date)
);

create or replace function increment_usage(p_user_id uuid, p_usage_date date, p_cost_usd numeric)
returns void as $$
begin
  insert into usage_daily (user_id, usage_date, cost_usd)
  values (p_user_id, p_usage_date, p_cost_usd)
  on conflict (user_id, usage_date)
  do update set cost_usd = usage_daily.cost_usd + excluded.cost_usd;
end;
$$ language plpgsql;

-- ---------------------------------------------------------------------------
-- Retrieval RPC — pure vector search across the whole knowledge base. The
-- platform isn't scoped to one subject, so there's no subject/topic FILTER
-- here; `subject`/`topic` on content_chunks remain useful ingestion/citation
-- metadata, just no longer part of the query path.
--
-- `subject` is nonetheless RETURNED (migrate_add_subject_to_retrieval_lanes.sql).
-- Returning it is not filtering on it: chat-handler.ts labels each chunk in the
-- context block with its subject so the tutor can see when a retrieved chunk
-- belongs to another subject. Without that label it once served a Sejarah
-- past-year question inside a Chemistry conversation, having been shown nothing
-- that said "Sejarah". Filtering by subject is done by the separate exam lane
-- (match_past_year_by_exam), which is a predicate, not a similarity.
-- ---------------------------------------------------------------------------

create or replace function match_content_chunks(
  query_embedding vector(768),
  match_count int default 5
)
returns table (
  id uuid,
  content text,
  source text,
  content_type text,
  difficulty text,
  material_id uuid,
  subject text
)
language sql stable
as $$
  select id, content, source, content_type, difficulty, material_id, subject
  from content_chunks
  order by embedding <=> query_embedding
  limit match_count;
$$;
