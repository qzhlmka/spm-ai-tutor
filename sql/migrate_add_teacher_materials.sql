-- Adds a teacher/student role to users, and a materials table tracking
-- per-teacher uploads via the new material-upload UI (src/lib/materials.ts).
-- Live data exists in users/content_chunks — additive only, no drops.

alter table users add column if not exists role text not null default 'student';

create table if not exists materials (
  id uuid primary key default gen_random_uuid(),
  uploaded_by uuid references users(id) on delete set null,
  filename text not null,
  exam_board text not null,
  subject text not null,
  topic text not null,
  chunk_count int not null default 0,
  status text not null default 'processing', -- 'processing' | 'done' | 'failed'
  error text,
  created_at timestamptz default now()
);

create index if not exists materials_uploaded_by_idx on materials (uploaded_by, created_at desc);

alter table content_chunks add column if not exists material_id uuid references materials(id) on delete set null;

-- After running this, manually promote known teacher accounts, e.g.:
-- update users set role = 'teacher' where email = 'teacher@example.com';
