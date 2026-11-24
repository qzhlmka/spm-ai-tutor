/**
 * Bulk-ingests the class-notes tree as teacher material.
 *
 * The teacher portal uploads one PDF per HTTP request, which is the wrong shape
 * for 107 files and ~1,146 pages of OCR — but the *result* has to be identical,
 * because retrieval treats a chunk as a teacher's own material only when it has
 * a material_id. So this walks the tree and performs the same steps the upload
 * path does (materials row -> optional storage -> vision extract -> runIngestion
 * -> status), rather than going through the CLI ingester, which would leave
 * material_id null and file the notes as ordinary background knowledge.
 *
 * Topics come from the reviewed notes-topics.json written by classify-notes.ts,
 * never from folder names directly, so the notes share the topic vocabulary the
 * Chemistry textbook already uses.
 *
 * Resumable and per-file fault-isolated: a file that fails is marked failed and
 * the run continues. Re-running skips anything already ingested, matched on the
 * file's sha256 — the same content_hash guard the upload path uses.
 */
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { supabase } from "../lib/supabase.js";
import { extractPagesVision } from "../ingest/vision-extract.js";
import { runIngestion } from "../ingest/ingest.js";

interface NoteEntry {
  hash: string;
  file: string;
  duplicates: string[];
  pages: number;
  topic: string;
}

interface Args {
  root: string;
  mapping: string;
  subject: string;
  examBoard: string;
  /** Omitted by default: bulk-ingested material has no human author, and naming
   * whoever ran the script credits them with writing a teacher's notes. Only a
   * real upload through the frontend gets an uploader. */
  uploadedBy: string | null;
  store: boolean;
  limit?: number;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Record<string, string> = {};
  let store = false;
  let dryRun = false;
  let root: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--store") { store = true; continue; }
    if (t === "--dry-run") { dryRun = true; continue; }
    if (t.startsWith("--")) { a[t.slice(2)] = argv[i + 1]; i++; continue; }
    root ??= t;
  }
  if (!root) throw new Error("Usage: tsx src/scripts/ingest-notes.ts <folder> --mapping notes-topics.json --subject Chemistry --exam-board SPM --uploaded-by <uuid> [--uploaded-by <uuid>] [--store] [--limit N] [--dry-run]");
  for (const k of ["mapping", "subject", "exam-board"]) {
    if (!a[k]) throw new Error(`Missing --${k}`);
  }
  return {
    root,
    mapping: a["mapping"],
    subject: a["subject"],
    examBoard: a["exam-board"],
    uploadedBy: a["uploaded-by"] ?? null,
    store,
    limit: a["limit"] ? Number(a["limit"]) : undefined,
    dryRun,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const entries: NoteEntry[] = JSON.parse(await readFile(args.mapping, "utf-8"));

  const unresolved = entries.filter((e) => e.topic === "UNRESOLVED");
  if (unresolved.length > 0) {
    throw new Error(`${unresolved.length} entries still have topic UNRESOLVED — fix ${args.mapping} first.`);
  }

  const todo = args.limit ? entries.slice(0, args.limit) : entries;
  console.log(`${todo.length} documents, ${todo.reduce((s, e) => s + e.pages, 0)} pages.`);
  if (args.dryRun) {
    for (const e of todo) console.log(`  [${e.topic}] ${e.file} (${e.pages}p)`);
    console.log("\nDry run — nothing written.");
    return;
  }

  let ingested = 0;
  let skipped = 0;
  let failed = 0;
  let chunkTotal = 0;

  for (const [i, entry] of todo.entries()) {
    const abs = path.join(args.root, entry.file);
    const filename = path.basename(entry.file);
    const label = `[${i + 1}/${todo.length}] ${entry.file}`;

    const buffer = await readFile(abs);
    const contentHash = createHash("sha256").update(buffer).digest("hex");

    const { data: existing } = await supabase
      .from("materials")
      .select("id")
      .eq("content_hash", contentHash)
      .eq("status", "done")
      .maybeSingle();
    if (existing) {
      console.log(`${label} — already ingested, skipping.`);
      skipped++;
      continue;
    }

    const { data: material, error: insertError } = await supabase
      .from("materials")
      .insert({
        uploaded_by: args.uploadedBy,
        filename,
        exam_board: args.examBoard,
        subject: args.subject,
        topic: entry.topic,
        content_hash: contentHash,
      })
      .select("id")
      .single();
    if (insertError || !material) {
      console.error(`${label} — could not create materials row:`, insertError?.message);
      failed++;
      continue;
    }

    try {
      if (args.store) {
        const filePath = `${args.uploadedBy ?? "library"}/${material.id}.pdf`;
        const { error: storageError } = await supabase.storage
          .from("materials")
          .upload(filePath, buffer, { contentType: "application/pdf" });
        if (storageError) {
          // Non-fatal, matching the upload path: the chunks are the point, the
          // downloadable original is a convenience. file_path stays null so the
          // student-facing library correctly hides a file it can't serve.
          console.warn(`${label} — original file not stored: ${storageError.message}`);
        } else {
          await supabase.from("materials").update({ file_path: filePath }).eq("id", material.id);
        }
      }

      // Always vision: these are annotated lesson slides whose text layer holds
      // only the printed captions (~180 chars/page measured), while the taught
      // content is handwritten over them.
      const cacheDir = path.join(".ocr-cache", contentHash.slice(0, 16));
      await mkdir(cacheDir, { recursive: true });
      console.log(`${label} — OCR ${entry.pages}p...`);
      const pages = await extractPagesVision(abs, cacheDir);

      const { chunkCount } = await runIngestion({
        pages,
        examBoard: args.examBoard,
        subject: args.subject,
        topic: entry.topic,
        materialId: material.id,
        sourceFile: filename,
      });

      await supabase
        .from("materials")
        .update({ status: "done", chunk_count: chunkCount })
        .eq("id", material.id);

      ingested++;
      chunkTotal += chunkCount;
      console.log(`${label} — done, ${chunkCount} chunks [${entry.topic}] (running total ${chunkTotal})`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Mark and move on. One unreadable PDF out of 107 should not cost the
      // whole run, and the failed row records why without stranding chunks:
      // runIngestion inserts per batch, so a partial file leaves rows behind —
      // they are findable and removable by source_file.
      await supabase.from("materials").update({ status: "failed", error: message }).eq("id", material.id);
      console.error(`${label} — FAILED: ${message}`);
      failed++;
    }
  }

  console.log(`\nIngested ${ingested}, skipped ${skipped}, failed ${failed}. ${chunkTotal} chunks added.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
