// Repairs source_page_images on teacher-material chunks ingested before the
// page-numbering fix in uploadPageImages(): images were named by their index
// inside a 6-page batch, so every batch wrote "page-0001.png" etc. and later
// batches overwrote earlier ones. Chunk text and embeddings were never wrong,
// so this re-derives only the image pointers — no rows are deleted and nothing
// is re-chunked. It does re-run vision OCR (the original OCR was in a temp dir
// that no longer exists); results are cached under .cache/vision-ocr/ so a
// re-run of this script is free.
//
// Usage: npx tsx src/scripts/repair-teacher-page-images.ts <materialId> [...]
//        npx tsx src/scripts/repair-teacher-page-images.ts --all
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { supabase } from "../lib/supabase.js";
import { PAGES_PER_BATCH, matchingPageIndices, uploadPageImages } from "../ingest/ingest.js";
import { extractPagesVision, pageImagePathsFor } from "../ingest/vision-extract.js";

const BACKUP_FILE = path.join(".cache", "backups", `teacher-page-images-before-repair-${new Date().toISOString().slice(0, 10)}.jsonl`);

/** The chunk came from exactly one 6-page window in the original run, so match
 * window by window and accept only a match found in a single window — the
 * same per-batch semantics the original ingestion used, plus a document-wide
 * uniqueness check it never had. Ambiguous or no match means no image. */
function globalPageIndices(content: string, pages: string[]): number[] {
  const hits: number[][] = [];
  for (let start = 0; start < pages.length; start += PAGES_PER_BATCH) {
    const local = matchingPageIndices(content, pages.slice(start, start + PAGES_PER_BATCH));
    if (local.length > 0) hits.push(local.map((i) => start + i));
  }
  return hits.length === 1 ? hits[0] : [];
}

async function repairOne(materialId: string): Promise<void> {
  const { data: material, error } = await supabase
    .from("materials")
    .select("id, filename, file_path")
    .eq("id", materialId)
    .single();
  if (error || !material?.file_path) {
    console.error(`[${materialId}] no materials row or file_path: ${error?.message ?? "missing"}`);
    return;
  }

  const { data: chunks, error: chunkError } = await supabase
    .from("content_chunks")
    .select("id, content, source_page_images")
    .eq("material_id", materialId);
  if (chunkError || !chunks) {
    console.error(`[${materialId}] could not load chunks: ${chunkError?.message}`);
    return;
  }

  // Back up the old pointers before touching anything.
  await appendFile(
    BACKUP_FILE,
    chunks.map((c) => JSON.stringify({ id: c.id, material_id: materialId, source_page_images: c.source_page_images })).join("\n") + "\n",
  );

  const cacheDir = path.join(".cache", "vision-ocr", `material-${materialId}`);
  await mkdir(cacheDir, { recursive: true });
  const pdfPath = path.join(cacheDir, "source.pdf");
  const { data: file, error: downloadError } = await supabase.storage.from("materials").download(material.file_path);
  if (downloadError || !file) {
    console.error(`[${materialId}] download failed: ${downloadError?.message}`);
    return;
  }
  await writeFile(pdfPath, Buffer.from(await file.arrayBuffer()));

  const pages = await extractPagesVision(pdfPath, cacheDir);
  const images = await pageImagePathsFor(cacheDir);
  if (images.length !== pages.length) {
    console.error(`[${materialId}] ${pages.length} pages but ${images.length} images — skipping`);
    return;
  }
  // extractPagesVision() turns a page whose OCR failed 3 times into "", so an
  // API outage looks like a blank document — and matching against blanks
  // would clear every chunk's pointer. Seen for real when credits ran out.
  const blank = pages.filter((p) => !p.trim()).length;
  if (blank > pages.length / 2) {
    console.error(`[${materialId}] ${blank}/${pages.length} pages empty after OCR — likely an API failure, skipping without changes`);
    return;
  }

  let matched = 0;
  let cleared = 0;
  for (const c of chunks) {
    const idx = globalPageIndices(c.content, pages);
    const next = idx.length > 0 ? await uploadPageImages(`materials/${materialId}`, images, idx, 0) : null;
    const value = next && next.length > 0 ? next : null;
    if (value) matched++;
    else if (c.source_page_images) cleared++;
    const { error: updateError } = await supabase.from("content_chunks").update({ source_page_images: value }).eq("id", c.id);
    if (updateError) console.error(`[${materialId}] update ${c.id} failed: ${updateError.message}`);
  }
  console.log(`[${materialId}] "${material.filename}" — ${chunks.length} chunks, ${matched} matched to a page, ${cleared} old pointers cleared`);
}

async function main() {
  await mkdir(path.dirname(BACKUP_FILE), { recursive: true });
  let ids = process.argv.slice(2);
  if (ids[0] === "--all") {
    const { data, error } = await supabase.from("content_chunks").select("material_id").not("source_page_images", "is", null).not("material_id", "is", null);
    if (error) throw new Error(error.message);
    ids = [...new Set((data ?? []).map((r) => r.material_id as string))];
  }
  if (ids.length === 0) {
    console.error("Usage: repair-teacher-page-images.ts <materialId> [...] | --all");
    process.exit(1);
  }
  console.log(`Repairing ${ids.length} material(s). Old pointers backed up to ${BACKUP_FILE}`);
  for (const id of ids) await repairOne(id);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
