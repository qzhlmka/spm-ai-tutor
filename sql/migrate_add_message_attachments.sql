-- Chat attachments (student-uploaded images/PDFs) were previously only held
-- in memory for the single Anthropic request that answered them — nothing
-- was ever written to storage, so the thumbnail/chip shown in the chat bubble
-- vanished on page refresh or server restart. This persists the original
-- file (private bucket, same signed-URL pattern as `materials`) plus a row
-- per attachment so conversation history reloads can redisplay it.

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
