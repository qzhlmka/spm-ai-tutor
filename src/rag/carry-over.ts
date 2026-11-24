/**
 * Exports the live rows that Phase 4 carries over instead of rebuilding
 * (decided 2026-10-13, see RAG_STATUS.md "Phase 4 decisions"): every teacher-
 * upload chunk (material_id set) and every past-year question that did not come
 * from one of the rebuilt textbooks. They keep their text, vector (same
 * multilingual-e5-base model, so comparable), exam labels, page images and
 * material link — things a plain re-ingest would lose (answer-key pairing,
 * exam labels) or cannot redo yet (teacher OCR text is not cached locally).
 *
 * READ-ONLY on the database. Writes a pilot-format index to .cache/pilot/<name>/.
 *
 *   npx tsx --env-file=.env src/rag/carry-over.ts [--name p4-carried] [--docs corpus-textbooks.txt]
 */
import path from "node:path";
import { supabase } from "../lib/supabase.js";
import { readDocList } from "./docs.js";
import { saveIndex, type IndexedChunk } from "./pilot-index.js";

const arg = (k: string, d: string) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
const name = arg("--name", "p4-carried");
const rebuilt = new Set(readDocList(arg("--docs", "corpus-textbooks.txt")).map((d) => path.basename(d.file)));

/** Physical page from the first stored page image ("…/page-0012.png" → 12), else 0 (unknown). */
const pageOf = (imgs: string[] | null) => Number(/(\d+)\.png$/.exec(imgs?.[0] ?? "")?.[1] ?? 0);
const MALAY = /\b(yang|dan|ialah|adalah|bagi|dengan|untuk|dalam|tidak|soalan|jawapan)\b/gi;
const ENGLISH = /\b(the|and|is|of|which|with|for|in|not|question|answer)\b/gi;
const languageOf = (t: string): "en" | "ms" => ((t.match(MALAY) ?? []).length > (t.match(ENGLISH) ?? []).length ? "ms" : "en");

type Row = Record<string, any>;
const rows: Row[] = [];
const COLS = "id, subject, topic, content_type, content, source, source_file, material_id, embedding, exam_year, exam_authority, exam_district, exam_set, exam_question_no, source_page_images";
for (const filter of ["teacher", "past_year"] as const) {
  for (let from = 0; ; from += 500) {
    let q = supabase.from("content_chunks").select(COLS).order("id").range(from, from + 499);
    q = filter === "teacher" ? q.not("material_id", "is", null) : q.eq("content_type", "past_year_question").is("material_id", null);
    const { data, error } = await q;
    if (error) throw error;
    rows.push(...(data ?? []));
    if ((data ?? []).length < 500) break;
  }
}
const kept = rows.filter((r) => !(r.source_file && rebuilt.has(r.source_file)));
const chunks: (IndexedChunk & Record<string, unknown>)[] = [];
const vecs: number[][] = [];
for (const r of kept) {
  const v: number[] = typeof r.embedding === "string" ? JSON.parse(r.embedding) : r.embedding;
  if (!Array.isArray(v) || v.length !== 768) continue;
  vecs.push(v);
  chunks.push({
    id: chunks.length,
    docId: r.source_file ? path.basename(r.source_file).replace(/\.pdf$/i, "").trim() : `(unattributed ${r.subject})`,
    page: pageOf(r.source_page_images),
    subject: r.subject,
    language: languageOf(r.content),
    text: r.content,
    origin: r.material_id ? "carried_teacher" : "carried_past_year",
    rowId: r.id,
    contentType: r.content_type,
    topic: r.topic,
    source: r.source,
    materialId: r.material_id,
    exam: { year: r.exam_year, authority: r.exam_authority, district: r.exam_district, set: r.exam_set, questionNo: r.exam_question_no },
    pageImages: r.source_page_images,
  });
}
const flat = new Float32Array(vecs.length * 768);
vecs.forEach((v, i) => flat.set(v, i * 768));
saveIndex(name, chunks, flat, { source: "live content_chunks (read-only export)", exportedAt: new Date().toISOString(), embedding: "multilingual-e5-base (live vectors, passageTextForChunk prefix)" });
const by = (k: string) => chunks.filter((c) => c.origin === k).length;
console.log(`fetched ${rows.length}, skipped ${rows.length - kept.length} from rebuilt textbooks → ${chunks.length} carried (teacher ${by("carried_teacher")}, past-year ${by("carried_past_year")}); with a page number: ${chunks.filter((c) => c.page > 0).length}`);
process.exit(0);
