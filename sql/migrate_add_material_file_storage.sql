-- Lets students browse/download the original uploaded file, not just ask
-- about its content via chat. Previously uploadMaterial() only extracted and
-- chunked text — the raw PDF itself was processed in-memory and discarded.
--
-- Private bucket (not public, unlike 'avatars') — these are course materials
-- for authenticated students only, not meant to be reachable by a bare public
-- URL. Access goes through a signed URL generated server-side per request
-- (src/lib/materials.ts), same requireUser()-gated pattern as everything else.
insert into storage.buckets (id, name, public)
values ('materials', 'materials', false)
on conflict (id) do nothing;

alter table materials add column if not exists file_path text;
