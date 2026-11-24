-- Adds a profile-picture column plus the storage bucket that hosts the
-- images. Additive-only, matches the existing migration pattern in this
-- directory.

alter table users add column if not exists avatar_url text;

-- Uploads go through the backend's service_role client (src/lib/profile.ts),
-- which bypasses storage RLS entirely — no storage.objects policies needed.
insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;
