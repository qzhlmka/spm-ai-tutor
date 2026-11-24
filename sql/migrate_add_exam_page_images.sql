-- Lets a past-year (or teacher-material) question that depends on a diagram be
-- answered by having the tutor actually LOOK at the source page, instead of
-- trusting a text description of it.
--
-- WHY. Measured against the real KB: 141/452 Add Maths past-year chunks, 123/454
-- Chemistry, 85/430 Physics and 39/398 Mathematics mention a diagram ("Rajah X
-- menunjukkan...") with NO usable description captured during OCR — the question
-- asks about coordinates/values that exist only in the image. A second, uncounted
-- failure mode sits beside that: some DO get a bracketed description, but for
-- Cartesian-plane/transformation questions it is often vacuous — "[Graph showing
-- two trapeziums, ABCD and EFGH, on a Cartesian plane]" restates the caption
-- without reading off the actual plotted coordinates the question depends on.
--
-- A text description is inherently lossy for this class of question. The fix is
-- to stop trying to describe the diagram in words at ingestion time and instead
-- keep a pointer to the actual rendered page image, so retrieval-time can hand
-- the real picture to the (vision-capable) tutor model — the same mechanism
-- already used for student-uploaded photos/PDFs (attachments.ts), just sourced
-- from the knowledge base instead of the current turn's upload.
--
-- Private bucket, same reasoning as 'materials': these are exam-source pages,
-- not meant to be reachable by a bare public URL. Access is a signed URL minted
-- server-side, or (more likely here) the bytes are read server-side and passed
-- to the model directly as an image content block — never handed to the client.
insert into storage.buckets (id, name, public)
values ('exam-page-images', 'exam-page-images', false)
on conflict (id) do nothing;

-- One chunk can legitimately need more than one page image (a question on one
-- page, its diagram or continuation on the next — see the ingestion pipeline's
-- own note on solutions landing on a later page than the question). Nullable:
-- the overwhelming majority of chunks have no page image at all (older
-- ingestions, or a source that was never rendered to images), and NULL/absent
-- is simply "nothing to attach", not an error state — the same optional-at-
-- runtime treatment as conversations.provider and content_chunks.subject.
alter table content_chunks add column if not exists source_page_images text[];
