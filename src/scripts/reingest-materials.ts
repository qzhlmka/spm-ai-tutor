// Re-ingests a set of already-uploaded teacher materials from scratch, so
// chunks that predate source_page_images (migrate_add_exam_page_images.sql)
// get a real page-image pointer this time instead of only a text description
// of any diagram — see the "Diagram-dependent past-year questions" section in
// CLAUDE.md. Deletes the material's existing chunks first, then re-runs the
// exact same extractPagesVision -> runIngestion pipeline uploadMaterial() uses,
// against the ORIGINAL file already sitting in the 'materials' storage bucket
// (no re-upload needed). Safe to re-run per material — it always starts from
// that material's own stored original, not from whatever chunks currently exist.
//
// Usage: npm run tsx src/scripts/reingest-materials.ts -- <materialId> [materialId...]
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { supabase } from "../lib/supabase.js";
import { runIngestion } from "../ingest/ingest.js";
import { extractPagesVision, pageImagePathsFor } from "../ingest/vision-extract.js";

async function reingestOne(materialId: string): Promise<void> {
  const { data: material, error } = await supabase
    .from("materials")
    .select("id, filename, exam_board, subject, topic, file_path, status")
    .eq("id", materialId)
    .single();
  if (error || !material) {
    console.error(`[${materialId}] could not load materials row: ${error?.message ?? "not found"}`);
    return;
  }
  if (!material.file_path) {
    console.error(`[${materialId}] "${material.filename}" has no stored file_path — nothing to re-ingest from.`);
    return;
  }

  console.log(`[${materialId}] "${material.filename}" — downloading original...`);
  const { data: fileData, error: downloadError } = await supabase.storage.from("materials").download(material.file_path);
  if (downloadError || !fileData) {
    console.error(`[${materialId}] download failed: ${downloadError?.message}`);
    return;
  }
  const buffer = Buffer.from(await fileData.arrayBuffer());

  const workDir = await mkdtemp(path.join(tmpdir(), "reingest-"));
  try {
    const pdfPath = path.join(workDir, "source.pdf");
    await writeFile(pdfPath, buffer);
    const cacheDir = path.join(workDir, "cache");

    console.log(`[${materialId}] running vision OCR...`);
    const pages = await extractPagesVision(pdfPath, cacheDir);
    const pageImages = await pageImagePathsFor(cacheDir);

    // Old chunks removed BEFORE inserting new ones — otherwise the material
    // briefly has two competing full sets of chunks, and if the insert below
    // fails partway the material is left with neither a clean old set nor a
    // complete new one. Content_chunks.material_id has no FK-cascade concern
    // here since we're deleting chunks, not the materials row itself.
    const { error: deleteError } = await supabase.from("content_chunks").delete().eq("material_id", materialId);
    if (deleteError) {
      console.error(`[${materialId}] failed to delete old chunks, aborting re-ingestion: ${deleteError.message}`);
      return;
    }

    console.log(`[${materialId}] chunking and inserting (${pages.length} pages)...`);
    const { chunkCount } = await runIngestion({
      pages,
      examBoard: material.exam_board,
      subject: material.subject,
      topic: material.topic,
      materialId: material.id,
      sourceFile: material.filename,
      pageImages,
    });

    const { error: updateError } = await supabase
      .from("materials")
      .update({ chunk_count: chunkCount })
      .eq("id", materialId);
    if (updateError) console.error(`[${materialId}] failed to update chunk_count: ${updateError.message}`);

    console.log(`[${materialId}] done — ${chunkCount} chunks.`);
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function main() {
  const ids = process.argv.slice(2);
  if (ids.length === 0) {
    console.error("Usage: reingest-materials.ts <materialId> [materialId...]");
    process.exit(1);
  }
  for (const id of ids) {
    await reingestOne(id);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
