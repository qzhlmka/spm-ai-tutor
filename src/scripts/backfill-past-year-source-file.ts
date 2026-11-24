/**
 * Fills `source_file` on past-year chunks ingested before that column existed.
 *
 * WHY THESE ROWS ARE NULL: `sql/migrate_add_chunk_source_file.sql` was applied
 * 2026-09-17. Every past-year ingestion before it (Add Maths 28 Jul, Physics +
 * Sejarah 30 Jul, Chemistry 6 Aug) predates the column; everything from 17 Sept
 * on has it. The cutoff is exact — no row straddles it.
 *
 * WHY THIS IS SAFE WHEN THE EARLIER ATTEMPT WASN'T: the previous effort tried to
 * attribute old rows by matching their TEXT back to source PDFs, and that cannot
 * work for vision-OCR'd material — the stored text is a transcription and never
 * the source's own wording, so cosine, exact-phrase and indexed-phrase search
 * all failed calibration (see CLAUDE.md). This script doesn't match content at
 * all. It uses provenance: each of these batches was one run of one script, and
 * those scripts hardcode their input path, so the file is known from the code
 * rather than guessed from the data.
 *
 * DELIBERATELY NOT COVERED:
 *  - Chemistry (296 rows, 6 Aug). No Chemistry past-year script exists in this
 *    repo, so that run went through the generic `npm run ingest` CLI and its
 *    path came from the command line. The SELEKOH book is the only plausible
 *    candidate — every other Chemistry past-year row comes from a class-notes
 *    file — but "only plausible candidate" is an inference, and writing an
 *    inferred filename into a column whose entire purpose is to be
 *    authoritative would make it useless. Left null until confirmed.
 *  - Sejarah (5 rows, 30 Jul). Labelled "Pemahaman dan Pemikiran Kritis",
 *    a section heading, which places them in no particular file.
 *
 * Idempotent: only touches rows where source_file IS NULL.
 *
 *   npx tsx --env-file=.env src/scripts/backfill-past-year-source-file.ts [--dry-run]
 */
import { supabase } from "../lib/supabase.js";

interface Rule {
  label: string;
  subject: string;
  sourceFile: string;
  /** Narrows within a subject when one run read more than one input PDF. */
  sourceLike?: string;
  sourceNotLike?: string;
  sourceIsNull?: boolean;
  /** What we expect to match — a mismatch aborts rather than writing. */
  expected: number;
}

const RULES: Rule[] = [
  {
    // src/ingest/ingest-past-year.ts:11 — BUKU_PDF. The two SKEMA PDFs that run
    // also reads only supplied answer letters; the question text, which is what
    // a chunk actually contains, came from the book.
    label: "Add Maths — SELEKOH book",
    subject: "Add Maths",
    sourceFile: "ADDMATH_BUKU SELEKOH AKHIR SPM 2024.pdf",
    expected: 452,
  },
  {
    // src/ingest/ingest-physics-past-year.ts:28 — QUIZ_PDF. Every one of these
    // carries the identical label "Kuiz Mingguan 2026 (KM: 1)", and no
    // book-derived row carries it, so the split is unambiguous.
    label: "Physics — weekly quiz",
    subject: "Physics",
    sourceFile: "KM26-5-F5-FIZIK.pdf",
    sourceLike: "%Kuiz%",
    expected: 20,
  },
  {
    // src/ingest/ingest-physics-past-year.ts:25 — BUKU_PDF, everything else.
    label: "Physics — book, labelled",
    subject: "Physics",
    sourceFile: "FIZIK_BUKU SELEKOH AKHIR SPM 2024.pdf",
    sourceNotLike: "%Kuiz%",
    expected: 389,
  },
  {
    // The remaining 21 Physics rows have a NULL `source`, and NOT ILIKE does not
    // match NULL — Postgres three-valued logic, which is why they need a rule of
    // their own rather than falling into the one above. They are book rows: the
    // quiz branch of that script assigns the literal string
    // "Kuiz Mingguan 2026 (KM: 1)" to every chunk it makes and can never
    // produce a null, while the book branch writes
    // `source_exam ? sanitize(source_exam) : null` — so a null source means the
    // OCR simply failed to read the exam label off a book page.
    label: "Physics — book, unlabelled",
    subject: "Physics",
    sourceFile: "FIZIK_BUKU SELEKOH AKHIR SPM 2024.pdf",
    sourceIsNull: true,
    expected: 21,
  },
];

function baseQuery(rule: Rule) {
  let q = supabase
    .from("content_chunks")
    .select("id", { count: "exact", head: true })
    .eq("content_type", "past_year_question")
    .eq("subject", rule.subject)
    .is("source_file", null);
  if (rule.sourceLike) q = q.ilike("source", rule.sourceLike);
  if (rule.sourceNotLike) q = q.not("source", "ilike", rule.sourceNotLike);
  if (rule.sourceIsNull) q = q.is("source", null);
  return q;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  console.log(dryRun ? "DRY RUN — nothing will be written\n" : "");

  // Count everything first. Writing rule 2 before checking rule 3 would change
  // rule 3's own population (both are "Physics, source_file is null"), so the
  // counts have to be taken while the table is still untouched.
  const counts: number[] = [];
  for (const rule of RULES) {
    const { count, error } = await baseQuery(rule);
    if (error) throw error;
    const n = count ?? 0;
    counts.push(n);
    const ok = n === rule.expected;
    console.log(`${ok ? "OK  " : "STOP"} ${rule.label.padEnd(28)} ${n} rows (expected ${rule.expected}) -> ${rule.sourceFile}`);
    if (!ok) {
      console.error(
        `\nAborting: the row count for "${rule.label}" is not what this script was written against. ` +
          `That means the data changed since the provenance was established, and the mapping can no ` +
          `longer be trusted. Re-check before forcing it.`,
      );
      process.exitCode = 1;
      return;
    }
  }

  if (dryRun) {
    console.log(`\nWould set source_file on ${counts.reduce((a, b) => a + b, 0)} rows.`);
    return;
  }

  let total = 0;
  for (const rule of RULES) {
    let q = supabase
      .from("content_chunks")
      .update({ source_file: rule.sourceFile })
      .eq("content_type", "past_year_question")
      .eq("subject", rule.subject)
      .is("source_file", null);
    if (rule.sourceLike) q = q.ilike("source", rule.sourceLike);
    if (rule.sourceNotLike) q = q.not("source", "ilike", rule.sourceNotLike);
    if (rule.sourceIsNull) q = q.is("source", null);
    const { error } = await q;
    if (error) {
      console.error(`failed on "${rule.label}"`, error);
      process.exitCode = 1;
      return;
    }
    console.log(`  wrote ${rule.label}`);
    total += rule.expected;
  }
  console.log(`\ndone — ${total} rows attributed.`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
