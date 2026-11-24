/**
 * Loads a local pilot-format index into the kb_chunks table (Phase 4,
 * sql/migrate_add_kb_chunks.sql). Writes ONLY to kb_chunks; content_chunks is
 * never touched.
 *
 *   npx tsx --env-file=.env src/rag/load-kb.ts [--index p4-full]
 *
 * Refuses to run when kb_chunks already has rows, so a re-run cannot duplicate
 * the textbook rows (carried rows are also protected by the unique legacy_chunk_id).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { supabase } from "../lib/supabase.js";
import { indexDir, loadIndex } from "./pilot-index.js";

const name = process.argv.includes("--index") ? process.argv[process.argv.indexOf("--index") + 1] : "p4-full";
const BATCH = 100;

const { count, error: countError } = await supabase.from("kb_chunks").select("id", { count: "exact", head: true });
if (countError) throw countError;
if ((count ?? 0) > 0) throw new Error(`kb_chunks already has ${count} rows — refusing to load on top of them`);

const ix = loadIndex(name);
const raw = readFileSync(path.join(indexDir(name), "vectors.f32"));
const vec = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
const dim = vec.length / ix.chunks.length;

let done = 0;
const t0 = Date.now();
for (let i = 0; i < ix.chunks.length; i += BATCH) {
  const rows = ix.chunks.slice(i, i + BATCH).map((c: any) => ({
    origin: c.origin ?? "textbook",
    doc_id: c.docId,
    page: c.page ?? 0,
    subject: c.subject ?? null,
    language: c.language ?? null,
    content: c.text,
    embedding: `[${Array.from(vec.subarray(c.id * dim, (c.id + 1) * dim)).join(",")}]`,
    content_type: c.contentType ?? null,
    topic: c.topic ?? null,
    source: c.source ?? null,
    material_id: c.materialId ?? null,
    legacy_chunk_id: c.rowId ?? null,
    exam_year: c.exam?.year ?? null,
    exam_authority: c.exam?.authority ?? null,
    exam_district: c.exam?.district ?? null,
    exam_set: c.exam?.set ?? null,
    exam_question_no: c.exam?.questionNo ?? null,
    source_page_images: c.pageImages ?? null,
  }));
  const { error } = await supabase.from("kb_chunks").insert(rows);
  if (error) throw new Error(`batch at ${i}: ${error.message}`);
  done += rows.length;
  if (done % 2000 < BATCH) console.log(`  ${done}/${ix.chunks.length} (${Math.round((Date.now() - t0) / 1000)}s)`);
}
console.log(`loaded ${done} rows from "${name}" into kb_chunks in ${Math.round((Date.now() - t0) / 1000)}s`);
process.exit(0);
