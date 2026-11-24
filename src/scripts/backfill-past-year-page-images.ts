/**
 * Attaches source page images to past-year questions that were ingested by the
 * bespoke subject scripts (which never stored any), so the tutor can show the
 * real diagram for "Rajah 2 menunjukkan…" questions, as it already does for
 * Chemistry (CLAUDE.md, "Diagram-dependent past-year questions").
 *
 * No OCR and no model calls. The ingest script's own OCR cache records, per
 * page, every question it transcribed, and each stored chunk's content IS that
 * transcription (plus an "Answer: X" line for keyed MCQs). So a chunk is matched
 * to its page(s) by its exam-source label and its exact text, not by
 * similarity. A question split across pages gets both pages, as the ingest
 * script merged them. A chunk that matches no question, or matches questions
 * on different pages, is left without an image: a wrong page shown as this
 * question's diagram is worse than none.
 *
 * Writes: storage objects in the private exam-page-images bucket (upsert), and
 * content_chunks.source_page_images for matched rows that have none. The
 * content_chunks_kb_sync trigger copies the change to kb_chunks. Nothing is
 * re-chunked or re-embedded. Old values (all null) are backed up first.
 *
 *   npx tsx --env-file=.env src/scripts/backfill-past-year-page-images.ts --subject Physics [--dry-run]
 *   npx tsx --env-file=.env src/scripts/backfill-past-year-page-images.ts --subject "Add Maths" [--dry-run]
 *   npx tsx --env-file=.env src/scripts/backfill-past-year-page-images.ts --subject Mathematics [--dry-run]
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { supabase } from "../lib/supabase.js";

interface CachedQuestion {
  question_no?: number;
  source_exam?: string | null;
  year?: number;
  soalan_no?: string;
  question_text: string;
}
interface CachedPage {
  page: number;
  questions?: CachedQuestion[];
}

interface Source {
  /** content_chunks.source_file of the rows this cache produced. */
  sourceFile: string;
  cacheDir: string;
  /** Storage folder; the file name is page-NNNN.png (the kb sync trigger reads the page from it). */
  storageDir: string;
  /** The weekly quiz has no per-question source label; every row carries this literal. */
  fixedSource?: string;
  /** How the ingest script built content_chunks.source from a cached question. Default: its source_exam. */
  label?: (q: CachedQuestion) => string;
  /** "fragments": the cache holds one piece per page and the stored chunk is all
   * pieces joined plus a worked solution (Add Maths). Default "questions": the
   * cache's question_no continuity marks a question carried onto the next page (Physics). */
  layout?: "questions" | "fragments" | "pagetext";
  /** pagetext: results.json is one OCR string per page (vision-extract.ts), index 0 = page 1. */
}

const SOURCES: Record<string, Source[]> = {
  Physics: [
    {
      sourceFile: "FIZIK_BUKU SELEKOH AKHIR SPM 2024.pdf",
      cacheDir: ".cache/physics-past-year-ocr/buku",
      storageDir: "past-year/physics-buku-selekoh-2024",
    },
    {
      sourceFile: "KM26-5-F5-FIZIK.pdf",
      cacheDir: ".cache/physics-past-year-ocr/quiz",
      storageDir: "past-year/physics-km26-5-f5",
      fixedSource: "Kuiz Mingguan 2026 (KM: 1)",
    },
  ],
  Mathematics: [
    {
      sourceFile: "MATEMATIK _ BUKU SELEKOH AKHIR SPM 2024.pdf",
      cacheDir: ".ocr-cache/maths-selekoh",
      storageDir: "past-year/maths-buku-selekoh-2024",
      layout: "pagetext",
    },
  ],
  "Add Maths": [
    {
      sourceFile: "ADDMATH_BUKU SELEKOH AKHIR SPM 2024.pdf",
      cacheDir: ".cache/past-year-ocr/buku",
      storageDir: "past-year/addmath-buku-selekoh-2024",
      // src/ingest/ingest-past-year.ts: source: `${source_exam} ${year} (Soalan ${soalan_no})`
      label: (q) => `${q.source_exam} ${q.year} (Soalan ${q.soalan_no})`,
      layout: "fragments",
    },
  ],
};

const BUCKET = "exam-page-images";
const arg = (k: string) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : undefined);
const subject = arg("--subject") ?? "";
const dryRun = process.argv.includes("--dry-run");
const sources = SOURCES[subject];
if (!sources) throw new Error(`--subject must be one of: ${Object.keys(SOURCES).join(", ")}`);

// Same control-char strip the ingest script applied before inserting.
const CONTROL = new RegExp(String.fromCharCode(91) + "\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F" + String.fromCharCode(93), "g");
const norm = (s: string) => s.replace(CONTROL, "").replace(/\s+/g, " ").trim().toLowerCase();
// Stored MCQs end with the key's letter, and Add Maths chunks wrap the question
// as "Question:\n…\n\nMarking Scheme:\n…"; neither wrapper was on the question page.
const stripAnswer = (s: string) =>
  s
    .replace(/\n\n(Answer|Jawapan):\s*[A-D]\s*$/i, "")
    .replace(/^Question:\s*/, "")
    .replace(/\n\nMarking Scheme:[\s\S]*$/, "");
const PREFIX = 160;

/** Questions in page order, with a question continued onto the next page merged
 * the way the ingest script merged it (same question number on consecutive entries). */
function questionsOf(pages: CachedPage[]): { text: string; source: string | null; pages: number[] }[] {
  const out: { no: number | undefined; text: string; source: string | null; pages: number[] }[] = [];
  for (const p of pages) {
    for (const q of p?.questions ?? []) {
      const last = out[out.length - 1];
      if (last && last.no === q.question_no && last.pages[last.pages.length - 1] === p.page - 1) {
        last.text += `\n${q.question_text}`;
        last.source ??= q.source_exam ?? null;
        last.pages.push(p.page);
      } else {
        out.push({ no: q.question_no, text: q.question_text, source: q.source_exam ?? null, pages: [p.page] });
      }
    }
  }
  return out;
}

/** Pagetext mode (src/scripts/ingest-maths-past-year.ts went through runIngestion,
 * whose chunks are the chunking model's lightly-edited copy of the page, not a
 * transcription): find the one page containing a run of the chunk's words. The
 * search covers the whole book rather than a 6-page batch, so a run is trusted
 * only when it occurs on exactly one page; several needles are tried, and none
 * unique means no image. A match in the last 40% of the page's text also takes
 * the next page — the question was printed near the end and may run over. */
const pageNorm = (s: string) => s.replace(/[^a-z0-9]+/gi, " ").trim().toLowerCase();
function matchPageText(content: string, pageTexts: string[]): { pages: number[]; why?: string } {
  const words = pageNorm(content).split(" ").filter(Boolean);
  const normed = pageTexts.map(pageNorm);
  let multi = false;
  for (const len of [12, 9]) {
    for (const offset of [0, 3, 6, 10, 15, 20, 30]) {
      if (words.length < offset + len) continue;
      const needle = words.slice(offset, offset + len).join(" ");
      const hits = normed.flatMap((t, i) => (t.includes(needle) ? [i] : []));
      if (hits.length > 1) multi = true;
      if (hits.length !== 1) continue;
      const i = hits[0];
      const page = i + 1;
      const late = normed[i].indexOf(needle) > 0.6 * normed[i].length;
      return { pages: late && page < pageTexts.length ? [page, page + 1] : [page] };
    }
  }
  return { pages: [], why: multi ? "ambiguous: text on several pages" : "no text match" };
}

/** Fragments mode: each cached piece is a candidate start of a stored question. */
function fragmentQuestions(pages: CachedPage[], labelOf: (q: CachedQuestion) => string) {
  return pages.flatMap((p) =>
    (p?.questions ?? []).map((q) => ({ text: q.question_text, source: labelOf(q), pages: [p.page], key: norm(q.question_text).slice(0, PREFIX) })),
  );
}

/** pdftoppm pads page numbers to the page count's width ("p-01.png" for a 13-page PDF), so match on the number. */
function renderedPage(src: Source, page: number): string | undefined {
  const dir = path.join(src.cacheDir, "pages");
  const f = readdirSync(dir).find((n) => Number(/-(\d+)\.png$/.exec(n)?.[1]) === page);
  return f && path.join(dir, f);
}

const storagePath = (src: Source, page: number) => `${src.storageDir}/page-${String(page).padStart(4, "0")}.png`;

const report: { id: string; source: string | null; pages: number[]; text: string }[] = [];
const unmatched: { id: string; source: string | null; why: string; text: string }[] = [];
const updates: { id: string; paths: string[]; old: string[] | null }[] = [];
const pagesNeeded = new Map<string, { src: Source; page: number }>();

for (const src of sources) {
  const raw = JSON.parse(readFileSync(path.join(src.cacheDir, "results.json"), "utf8"));
  const pageTexts: string[] = src.layout === "pagetext" ? (raw as string[]) : [];
  const pages = (src.layout === "pagetext" ? [] : raw) as CachedPage[];
  const labelOf = src.label ?? ((q: CachedQuestion) => q.source_exam ?? "");
  const questions =
    src.layout === "fragments"
      ? fragmentQuestions(pages, labelOf)
      : questionsOf(pages).map((q) => ({ ...q, key: norm(q.text).slice(0, PREFIX) }));
  // The last question printed on each page. A question there often runs onto the
  // next page — with its diagram — without the OCR recording a continuation
  // (seen in the Add Maths check: TRIAL MELAKA 2022 Soalan 9 starts at the foot of
  // p.51, Rajah 20 is on p.52), so such a question also gets the next page.
  const lastOnPage = new Map<number, string>();
  for (const p of pages) {
    const qs = p?.questions ?? [];
    if (qs.length) lastOnPage.set(p.page, norm(qs[qs.length - 1].question_text));
  }
  const pageCount = src.layout === "pagetext" ? pageTexts.length : Math.max(...pages.filter(Boolean).map((p) => p.page));
  // Fragments mode: every piece, so a chunk's continuation pages can be found.
  const fragments = pages.flatMap((p) => (p?.questions ?? []).map((q) => ({ page: p.page, label: norm(labelOf(q)), key: norm(q.question_text) })));

  const rows: { id: string; content: string; source: string | null; source_page_images: string[] | null }[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("content_chunks")
      .select("id, content, source, source_page_images")
      .eq("subject", subject)
      .eq("content_type", "past_year_question")
      .eq("source_file", src.sourceFile)
      .order("id")
      .range(from, from + 999);
    if (error) throw error;
    rows.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }

  let already = 0;
  for (const r of rows) {
    // A row with pointers is only revisited when they are this script's own
    // (same storage folder), so a later rule can extend them; anything else
    // (e.g. set by an ingest) is left alone.
    const existing = r.source_page_images ?? [];
    if (existing.length && !existing.every((x) => x.startsWith(`${src.storageDir}/`))) {
      already++;
      continue;
    }
    const body = norm(stripAnswer(r.content));
    if (src.layout === "pagetext") {
      const m = matchPageText(stripAnswer(r.content), pageTexts);
      if (m.pages.length === 0) {
        unmatched.push({ id: r.id, source: r.source, why: m.why!, text: r.content.slice(0, 120) });
        continue;
      }
      const paths = m.pages.map((p) => storagePath(src, p));
      if (existing.length && existing.join() === paths.join()) {
        already++;
        continue;
      }
      for (const p of m.pages) pagesNeeded.set(storagePath(src, p), { src, page: p });
      updates.push({ id: r.id, paths, old: existing.length ? existing : null });
      report.push({ id: r.id, source: r.source, pages: m.pages, text: r.content.slice(0, 200) });
      continue;
    }
    const textHits = questions.filter((q) => body.startsWith(q.key) || q.key.startsWith(body.slice(0, PREFIX)));
    // The exam label disambiguates a question reprinted in two chapters; the
    // quiz has none, so text alone decides there.
    const hits = src.fixedSource ? textHits : textHits.filter((q) => norm(q.source ?? "") === norm(r.source ?? ""));
    const pageSets = new Set(hits.map((h) => h.pages.join(",")));
    if (hits.length === 0) {
      unmatched.push({ id: r.id, source: r.source, why: textHits.length ? "text matched, label did not" : "no text match", text: r.content.slice(0, 120) });
      continue;
    }
    if (pageSets.size > 1) {
      unmatched.push({ id: r.id, source: r.source, why: `ambiguous: pages ${[...pageSets].join(" | ")}`, text: r.content.slice(0, 120) });
      continue;
    }
    let pageList = hits[0].pages;
    if (src.layout === "fragments") {
      // The start page, plus every later piece with the same label whose text is
      // inside this chunk, on the pages directly following (a 3-page question at most).
      const start = pageList[0];
      const cont = fragments.filter(
        (f) => f.page > start && f.page <= start + 3 && f.label === norm(r.source ?? "") && f.key.length >= 20 && body.includes(f.key),
      );
      pageList = [...new Set([start, ...cont.map((f) => f.page)])].sort((a, b) => a - b);
      if (pageList.some((p, i) => i > 0 && p !== pageList[i - 1] + 1)) {
        unmatched.push({ id: r.id, source: r.source, why: `non-contiguous pages ${pageList.join(",")}`, text: r.content.slice(0, 120) });
        continue;
      }
    }
    const end = pageList[pageList.length - 1];
    const last = lastOnPage.get(end);
    if (last && last.length >= 20 && body.includes(last.slice(0, PREFIX)) && end < pageCount && !pageList.includes(end + 1)) {
      pageList = [...pageList, end + 1];
    }
    const missing = pageList.filter((p) => !renderedPage(src, p));
    if (missing.length) {
      unmatched.push({ id: r.id, source: r.source, why: `rendered page missing: ${missing.join(",")}`, text: r.content.slice(0, 120) });
      continue;
    }
    const paths = pageList.map((p) => storagePath(src, p));
    if (existing.length && existing.join() === paths.join()) {
      already++;
      continue;
    }
    for (const p of pageList) pagesNeeded.set(storagePath(src, p), { src, page: p });
    updates.push({ id: r.id, paths, old: existing.length ? existing : null });
    report.push({ id: r.id, source: r.source, pages: pageList, text: r.content.slice(0, 200) });
  }
  console.log(`${src.sourceFile}: ${rows.length} rows, ${already} already up to date (or set elsewhere), cache has ${questions.length} questions`);
}

const multi = updates.filter((u) => u.paths.length > 1).length;
const extending = updates.filter((u) => u.old).length;
console.log(`\nto write ${updates.length} (${multi} with two+ pages; ${extending} extend pointers set by an earlier run), unmatched ${unmatched.length}, distinct pages to upload ${pagesNeeded.size}`);
const why: Record<string, number> = {};
for (const u of unmatched) why[u.why.split(":")[0]] = (why[u.why.split(":")[0]] ?? 0) + 1;
console.log("unmatched by reason:", why);

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
mkdirSync(".cache/backups", { recursive: true });
const reportFile = `.cache/backups/past-year-images-${subject}-${dryRun ? "dryrun" : "applied"}-${stamp}.json`;
writeFileSync(reportFile, JSON.stringify({ matched: report, unmatched }, null, 2));
console.log(`report: ${reportFile}`);
if (dryRun) process.exit(0);

// Backup: every row about to change, with its current (null) value.
const backupFile = `.cache/backups/past-year-images-${subject}-before-${stamp}.json`;
writeFileSync(backupFile, JSON.stringify(updates.map((u) => ({ id: u.id, source_page_images: u.old })), null, 2));
console.log(`backup: ${backupFile}`);

const failures: string[] = [];
let uploaded = 0;
for (const [target, { src, page }] of pagesNeeded) {
  const file = renderedPage(src, page)!;
  const { error } = await supabase.storage.from(BUCKET).upload(target, readFileSync(file), { contentType: "image/png", upsert: true });
  if (error) failures.push(`upload ${target}: ${error.message}`);
  else uploaded++;
}
console.log(`uploaded ${uploaded}/${pagesNeeded.size} pages`);
if (failures.length) {
  console.log(failures.slice(0, 10).join("\n"));
  throw new Error("uploads failed; no rows updated");
}

let updated = 0;
for (const u of updates) {
  // Only if the row still holds what was read: never overwrite a pointer set since.
  const q = supabase.from("content_chunks").update({ source_page_images: u.paths }, { count: "exact" }).eq("id", u.id);
  const { error, count } = await (u.old ? q.filter("source_page_images", "eq", `{${u.old.join(",")}}`) : q.is("source_page_images", null));
  if (error) failures.push(`update ${u.id}: ${error.message}`);
  else updated += count ?? 0;
}
console.log(`updated ${updated}/${updates.length} rows${failures.length ? `\nFAILURES:\n${failures.slice(0, 10).join("\n")}` : ""}`);
process.exit(0);
