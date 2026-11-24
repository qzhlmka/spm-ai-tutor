-- Links public.users to Supabase Auth (auth.users) so a login IS the
-- conversation owner, and adds title/updated_at to conversations for the
-- web sidebar (title + "most recently active" ordering) and multi-turn
-- conversation memory. Chat persistence was never wired up before this
-- migration, so users/conversations/messages are still empty — safe to
-- drop and recreate rather than write a data migration.

drop table if exists messages;
drop table if exists conversations;
drop table if exists users;

create table users (
  id uuid primary key references auth.users(id) on delete cascade,
  telegram_id text unique,
  email text unique,
  display_name text,
  created_at timestamptz default now()
);

create table conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  subject text,
  title text,
  updated_at timestamptz default now(),
  created_at timestamptz default now()
);

create index conversations_user_updated_idx on conversations (user_id, updated_at desc);

create table messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  role text not null,
  channel text not null,
  content text not null,
  created_at timestamptz default now()
);

create index messages_conversation_idx on messages (conversation_id, created_at);
