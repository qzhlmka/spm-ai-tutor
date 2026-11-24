import { z } from "zod";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { supabase } from "./supabase.js";
import type { AuthedUser } from "./auth.js";
import { runIngestion } from "../ingest/ingest.js";
import { extractPagesVision, pageImagePathsFor } from "../ingest/vision-extract.js";

// Framework-agnostic core for the teacher material-upload endpoints — same
// pattern as chat-handler.ts/conversations.ts, called from both
// src/routes/materials.ts (standalone Fastify) and frontend/vite-plugins/api.ts
// (local dev), one source of truth.

// Base64-inflated PDF cap — see the MAX_BODY_BYTES comment in src/server.ts /
// frontend/vite-plugins/api.ts for the matching request-body ceiling. Large
// scanned textbooks should keep going through `npm run ingest -- --vision`.
const MAX_FILE_BYTES = 40 * 1024 * 1024;

const uploadMaterialSchema = z.object({
  filename: z.string().min(1),
  mimeType: z.string().min(1),
  fileBase64: z.string().min(1),
  examBoard: z.string().min(1),
  subject: z.string().min(1),
  topic: z.string().min(1),
});

export type UploadMaterialResult =
  | { status: 200; body: { materialId: string; chunkCount: number } }
  | { status: 400; body: { error: string } }
  | { status: 401; body: { error: string } }
  | { status: 403; body: { error: string } }
  | { status: 409; body: { error: string } }
  | { status: 500; body: { error: string } };

export async function uploadMaterial(user: AuthedUser | null, input: unknown): Promise<UploadMaterialResult> {
  if (!user) {
    return { status: 401, body: { error: "Login required" } };
  }
  if (user.role !== "teacher") {
    return { status: 403, body: { error: "Teacher account required" } };
  }

  const parsed = uploadMaterialSchema.safeParse(input);
  if (!parsed.success) {
    return { status: 400, body: { error: parsed.error.issues[0]?.message ?? "Invalid request" } };
  }
  const { filename, mimeType, fileBase64, examBoard, subject, topic } = parsed.data;

  if (mimeType !== "application/pdf") {
    return { status: 400, body: { error: "Only PDF files are supported right now" } };
  }

  const buffer = Buffer.from(fileBase64, "base64");
  if (buffer.byteLength > MAX_FILE_BYTES) {
    return { status: 400, body: { error: `File too large — max ${Math.floor(MAX_FILE_BYTES / (1024 * 1024))}MB` } };
  }

  // Dedupe on the raw file bytes, not filename — teachers re-upload the same
  // PDF under a renamed or re-exported copy often enough that filename
  // matching would miss it, and a byte-identical re-upload has previously
  // produced a second full set of content_chunks competing for the same
  // retrieval slots (see migrate_add_material_content_hash.sql).
  const contentHash = createHash("sha256").update(buffer).digest("hex");
  const { data: existing } = await supabase
    .from("materials")
    .select("id, filename")
    .eq("uploaded_by", user.id)
    .eq("content_hash", contentHash)
    .eq("status", "done")
    .maybeSingle();
  if (existing) {
    return {
      status: 409,
      body: { error: `This file is already uploaded as "${existing.filename}" — delete it first if you want to replace it.` },
    };
  }

  const { data: material, error: insertError } = await supabase
    .from("materials")
    .insert({ uploaded_by: user.id, filename, exam_board: examBoard, subject, topic, content_hash: contentHash })
    .select("id")
    .single();
  if (insertError || !material) {
    console.error("failed to create materials row", insertError);
    return { status: 500, body: { error: "Couldn't start upload" } };
  }

  try {
    const filePath = `${material.id}/${filename}`;
    const { error: storageError } = await supabase.storage
      .from("materials")
      .upload(filePath, buffer, { contentType: "application/pdf", upsert: true });
    if (storageError) {
      // Not fatal — students lose the "download original file" capability for
      // this upload, but chat-based Q&A (the core feature) still works fine
      // once ingestion below succeeds, so don't fail the whole upload over it.
      console.error("failed to store original material file", storageError);
    }

    // Teacher-uploaded slide decks routinely mix a usable text layer with
    // embedded diagram/chart images (pdf-parse extracts the captions fine,
    // so `looksLikeScannedText()` never trips — but the diagrams themselves
    // are silently dropped). Teacher decks are small (20-40 pages), so unlike
    // the CLI's textbook-scale ingestion, always pay the vision-OCR cost here
    // rather than gate it on the near-empty-text heuristic.
    const workDir = await mkdtemp(path.join(tmpdir(), "material-ocr-"));
    let chunkCount: number;
    try {
      const pdfPath = path.join(workDir, "source.pdf");
      await writeFile(pdfPath, buffer);
      const cacheDir = path.join(workDir, "cache");
      const pages = await extractPagesVision(pdfPath, cacheDir);
      // Read BEFORE the workDir cleanup below deletes the rendered pages —
      // runIngestion needs the actual files on disk to upload the ones it
      // matches to a chunk (see matchingPageIndices/uploadPageImages).
      const pageImages = await pageImagePathsFor(cacheDir);
      ({ chunkCount } = await runIngestion({
        pages,
        examBoard,
        subject,
        topic,
        materialId: material.id,
        sourceFile: filename,
        pageImages,
      }));
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }

    const { error: updateError } = await supabase
      .from("materials")
      .update({ status: "done", chunk_count: chunkCount, file_path: storageError ? null : filePath })
      .eq("id", material.id);
    if (updateError) {
      console.error("failed to mark material done", updateError);
    }

    return { status: 200, body: { materialId: material.id, chunkCount } };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Ingestion failed";
    console.error("material ingestion failed", err);
    const { error: updateError } = await supabase
      .from("materials")
      .update({ status: "failed", error: message })
      .eq("id", material.id);
    if (updateError) {
      console.error("failed to mark material failed", updateError);
    }
    return { status: 500, body: { error: `Ingestion failed: ${message}` } };
  }
}

export type ListMaterialsResult =
  | {
      status: 200;
      body: {
        materials: {
          id: string;
          filename: string;
          examBoard: string;
          subject: string;
          topic: string;
          chunkCount: number;
          status: string;
          error: string | null;
          createdAt: string;
          /** False when the original PDF never reached storage. Ingestion treats
           * that as non-fatal, so the row still says "done" — without this the
           * teacher has no way to tell that the file students would download is
           * simply missing. */
          hasFile: boolean;
        }[];
      };
    }
  | { status: 401; body: { error: string } }
  | { status: 500; body: { error: string } };

export async function listMaterials(user: AuthedUser | null): Promise<ListMaterialsResult> {
  if (!user) {
    return { status: 401, body: { error: "Login required" } };
  }

  const { data, error } = await supabase
    .from("materials")
    .select("id, filename, exam_board, subject, topic, chunk_count, status, error, created_at, file_path")
    .eq("uploaded_by", user.id)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("failed to list materials", error);
    return { status: 500, body: { error: "Couldn't load materials" } };
  }

  return {
    status: 200,
    body: {
      materials: (data ?? []).map((m) => ({
        id: m.id,
        filename: m.filename,
        examBoard: m.exam_board,
        subject: m.subject,
        topic: m.topic,
        chunkCount: m.chunk_count,
        status: m.status,
        error: m.error,
        createdAt: m.created_at,
        hasFile: m.file_path !== null,
      })),
    },
  };
}

export type MaterialsLibraryResult =
  | {
      status: 200;
      body: {
        materials: {
          id: string;
          filename: string;
          examBoard: string;
          subject: string;
          topic: string;
          createdAt: string;
          uploadedById: string | null;
          /** null for material that was bulk-ingested rather than uploaded by a
           * person — see the comment on the mapping below. */
          uploadedByName: string | null;
        }[];
      };
    }
  | { status: 401; body: { error: string } }
  | { status: 500; body: { error: string } };

/** Student-facing browse list — every successfully-processed upload with a
 * downloadable file, regardless of who uploaded it (unlike listMaterials(),
 * which is scoped to the teacher's own uploads for their upload-management
 * view). Any authenticated user (student or teacher) can see this. */
export async function listMaterialsLibrary(user: AuthedUser | null): Promise<MaterialsLibraryResult> {
  if (!user) {
    return { status: 401, body: { error: "Login required" } };
  }

  const { data, error } = await supabase
    .from("materials")
    .select("id, filename, exam_board, subject, topic, created_at, uploaded_by, uploader:users(display_name, email)")
    .eq("status", "done")
    .not("file_path", "is", null)
    .order("subject")
    .order("topic")
    .order("created_at", { ascending: false });

  if (error) {
    console.error("failed to list materials library", error);
    return { status: 500, body: { error: "Couldn't load materials" } };
  }

  return {
    status: 200,
    body: {
      materials: (data ?? []).map((m) => {
        const uploader = (Array.isArray(m.uploader) ? m.uploader[0] : m.uploader) as
          | { display_name: string | null; email: string | null }
          | null;
        return {
          id: m.id,
          filename: m.filename,
          examBoard: m.exam_board,
          subject: m.subject,
          topic: m.topic,
          createdAt: m.created_at,
          // Returned so the library UI can show the edit/delete actions only on
          // rows the viewer owns. It's the same id the client already knows as
          // its own from GET /api/profile, not a lookup key for anything else —
          // the server re-checks ownership on every mutating call regardless.
          uploadedById: m.uploaded_by,
          // Material ingested from the command line has no uploader, and inventing
          // one is worse than showing none: naming whoever happened to run the
          // script credits them with authoring a teacher's work. `null` means "no
          // author to show", and the UI omits the byline rather than printing a
          // placeholder like "Unknown teacher" — which also kept leaking into the
          // library's teacher filter as though it were a real person.
          uploadedByName: m.uploaded_by ? uploader?.display_name || uploader?.email || null : null,
        };
      }),
    },
  };
}

const DOWNLOAD_URL_EXPIRY_SECONDS = 60 * 5;

export type MaterialDownloadUrlResult =
  | { status: 200; body: { url: string } }
  | { status: 401; body: { error: string } }
  | { status: 404; body: { error: string } }
  | { status: 500; body: { error: string } };

/** Materials are stored in a private bucket (not public like avatars) — every
 * download goes through this signed-URL mint, gated by requireUser() same as
 * any other endpoint, rather than a bare public file URL.
 *
 * `disposition` picks what the browser does with the signed URL. "inline" (the
 * default) leaves the object's application/pdf content type alone so the URL can
 * be dropped straight into an <iframe> and read in-app — students reported that
 * having to download a PDF before they could look at it was the main friction in
 * this screen. "attachment" asks storage for a Content-Disposition header, and
 * names the file after the material's *display* filename rather than the stored
 * path: renaming a material deliberately leaves the storage object where it is
 * (see updateMaterial), so without this a renamed PDF would still save to disk
 * under its original, pre-rename name. */
export async function getMaterialDownloadUrl(
  user: AuthedUser | null,
  materialId: string,
  disposition: "inline" | "attachment" = "inline",
): Promise<MaterialDownloadUrlResult> {
  if (!user) {
    return { status: 401, body: { error: "Login required" } };
  }

  const { data: material, error: fetchError } = await supabase
    .from("materials")
    .select("file_path, filename, status")
    .eq("id", materialId)
    .maybeSingle();
  if (fetchError) {
    console.error("failed to load material for download", fetchError);
    return { status: 500, body: { error: "Couldn't load material" } };
  }
  if (!material || material.status !== "done" || !material.file_path) {
    return { status: 404, body: { error: "Material not found" } };
  }

  const { data: signed, error: signError } = await supabase.storage
    .from("materials")
    .createSignedUrl(
      material.file_path,
      DOWNLOAD_URL_EXPIRY_SECONDS,
      disposition === "attachment" ? { download: material.filename } : undefined,
    );
  if (signError || !signed) {
    console.error("failed to sign material download url", signError);
    return { status: 500, body: { error: "Couldn't generate download link" } };
  }

  return { status: 200, body: { url: signed.signedUrl } };
}

const MAX_FILENAME_LENGTH = 200;

const updateMaterialSchema = z
  .object({
    filename: z.string().trim().min(1, "Name can't be empty").max(MAX_FILENAME_LENGTH).optional(),
    subject: z.string().trim().min(1, "Subject can't be empty").optional(),
    topic: z.string().trim().min(1, "Topic can't be empty").optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "Nothing to update" });

export type UpdateMaterialResult =
  | { status: 200; body: { id: string; filename: string; subject: string; topic: string } }
  | { status: 400; body: { error: string } }
  | { status: 401; body: { error: string } }
  | { status: 403; body: { error: string } }
  | { status: 404; body: { error: string } }
  | { status: 500; body: { error: string } };

/** Edit a material's display metadata. Teachers have repeatedly typed the same
 * subject four different ways across uploads ("Chemistry", "Chemistry Form 5",
 * "Chemistry, Kimia", "Kimia Form 4"), which fragments the library's
 * subject grouping and the subject anchor every teacher chunk is embedded with —
 * so subject/topic are editable here, not just the filename.
 *
 * `filename` is purely a display name: the stored object keeps living at its
 * original `{id}/{original name}` path and `file_path` is left untouched, so a
 * rename can't half-succeed and strand the PDF. getMaterialDownloadUrl() passes
 * this filename to storage as the Content-Disposition name, so an actual
 * download still arrives under the new name. */
export async function updateMaterial(
  user: AuthedUser | null,
  materialId: string,
  input: unknown,
): Promise<UpdateMaterialResult> {
  if (!user) {
    return { status: 401, body: { error: "Login required" } };
  }
  if (user.role !== "teacher") {
    return { status: 403, body: { error: "Teacher account required" } };
  }

  const parsed = updateMaterialSchema.safeParse(input);
  if (!parsed.success) {
    return { status: 400, body: { error: parsed.error.issues[0]?.message ?? "Invalid request" } };
  }
  const patch = parsed.data;

  // Scoped to the caller's own uploads — a teacher can't edit another
  // teacher's material even though the library shows them everyone's.
  const { data, error } = await supabase
    .from("materials")
    .update(patch)
    .eq("id", materialId)
    .eq("uploaded_by", user.id)
    .select("id, filename, subject, topic")
    .maybeSingle();

  if (error) {
    console.error("failed to update material", error);
    return { status: 500, body: { error: "Couldn't save changes" } };
  }
  if (!data) {
    return { status: 404, body: { error: "Material not found" } };
  }

  // content_chunks carries its own copy of subject/topic (it predates
  // materials, and the CLI ingestion path has no materials row at all), so a
  // corrected label has to be pushed down or retrieval keeps reporting the
  // typo'd one. Note this does NOT re-embed: passageTextForChunk() bakes
  // subject/topic into the embedded passage text, so the vector still carries
  // the old wording until `npm run reembed`. That's deliberate — re-embedding a
  // whole material inline would turn a rename into a multi-second request — and
  // it only shifts ranking slightly, since the corrected labels are near-
  // synonyms of the originals.
  if (patch.subject !== undefined || patch.topic !== undefined) {
    const chunkPatch: { subject?: string; topic?: string } = {};
    if (patch.subject !== undefined) chunkPatch.subject = patch.subject;
    if (patch.topic !== undefined) chunkPatch.topic = patch.topic;
    const { error: chunkError } = await supabase.from("content_chunks").update(chunkPatch).eq("material_id", materialId);
    if (chunkError) {
      // Non-fatal: the teacher-visible rename already landed, and the chunks
      // keep working under their old labels.
      console.error("failed to propagate material labels to content_chunks", chunkError);
    }
  }

  return { status: 200, body: { id: data.id, filename: data.filename, subject: data.subject, topic: data.topic } };
}

export type DeleteMaterialResult =
  | { status: 200; body: { id: string; deletedChunks: number } }
  | { status: 401; body: { error: string } }
  | { status: 403; body: { error: string } }
  | { status: 404; body: { error: string } }
  | { status: 500; body: { error: string } };

export async function deleteMaterial(user: AuthedUser | null, materialId: string): Promise<DeleteMaterialResult> {
  if (!user) {
    return { status: 401, body: { error: "Login required" } };
  }
  if (user.role !== "teacher") {
    return { status: 403, body: { error: "Teacher account required" } };
  }

  const { data: material, error: fetchError } = await supabase
    .from("materials")
    .select("id, file_path")
    .eq("id", materialId)
    .eq("uploaded_by", user.id)
    .maybeSingle();
  if (fetchError) {
    console.error("failed to load material for delete", fetchError);
    return { status: 500, body: { error: "Couldn't delete material" } };
  }
  if (!material) {
    return { status: 404, body: { error: "Material not found" } };
  }

  // Order matters. content_chunks.material_id is `on delete set null`, so
  // dropping the materials row first would silently orphan every chunk — they'd
  // stay in the knowledge base forever with no remaining way to find them, and
  // the tutor would keep teaching from notes the teacher believes are gone.
  // Delete the chunks first, and bail out if that fails rather than continuing
  // to a state where the row is gone but the content isn't.
  const { data: deletedChunks, error: chunkError } = await supabase
    .from("content_chunks")
    .delete()
    .eq("material_id", materialId)
    .select("id");
  if (chunkError) {
    console.error("failed to delete material chunks", chunkError);
    return { status: 500, body: { error: "Couldn't delete material" } };
  }

  if (material.file_path) {
    const { error: storageError } = await supabase.storage.from("materials").remove([material.file_path]);
    if (storageError) {
      // Treated the same way the upload path treats a failed store: a missing
      // or already-removed object leaves at worst an unreferenced file in the
      // bucket, which nothing can reach once the row below is gone. Blocking
      // the delete on it would strand the teacher with a material whose
      // content is already deleted but which still appears in the library.
      console.error("failed to remove material file from storage", storageError);
    }
  }

  const { error: deleteError } = await supabase
    .from("materials")
    .delete()
    .eq("id", materialId)
    .eq("uploaded_by", user.id);
  if (deleteError) {
    console.error("failed to delete material row", deleteError);
    return { status: 500, body: { error: "Couldn't delete material" } };
  }

  return { status: 200, body: { id: materialId, deletedChunks: deletedChunks?.length ?? 0 } };
}
