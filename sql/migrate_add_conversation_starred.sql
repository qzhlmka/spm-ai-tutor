-- Adds a "starred" (pinned) flag to conversations, surfaced via a right-click
-- context menu in the sidebar. Additive-only, matches the existing migration
-- pattern in this directory.

alter table conversations add column if not exists starred boolean not null default false;

drop index if exists conversations_user_updated_idx;
create index conversations_user_updated_idx on conversations (user_id, starred desc, updated_at desc);
