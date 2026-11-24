/**
 * Populates content_chunks.exam_* from the free-text `source` label.
 *
 * Safe to re-run: it recomputes every past-year row from `source` and writes
 * the result, so a parser improvement is applied by running it again. It never
 * touches `content` or `embedding` — the exam label is deliberately not part of
 * the embedded passage text (see sql migration add_exam_label_columns), so no
 * re-embedding is needed and retrieval behaviour for every existing question is
 * bit-for-bit unchanged until the new lane is wired up.
 *
 *   npx tsx --env-file=.env src/scripts/backfill-exam-labels.ts [--dry-run]
 */
import { supabase } from "../lib/supabase.js";
import { parseExamLabel } from "../lib/exam-label.js";

const PAGE = 1000;
const WRITE_BATCH = 200;

interface Row {
  id: string;
  subject: string;
  source: string | null;
}

async function loadAll(): Promise<Row[]> {
  // Explicit pagination: PostgREST caps a response at db-max-rows (1000) and
  // .range() cannot raise it, so a single ranged read silently truncates.
  const rows: Row[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("content_chunks")
      .select("id, subject, source")
      .eq("content_type", "past_year_question")
      .order("id")
      .range(from, from + PAGE - 1);
    if (error) throw error;
    rows.push(...((data ?? []) as Row[]));
    if ((data ?? []).length < PAGE) break;
  }
  return rows;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const rows = await loadAll();
  console.log(`past-year chunks: ${rows.length}${dryRun ? "  (dry run — nothing will be written)" : ""}`);

  const updates = rows.map((r) => {
    const label = parseExamLabel(r.source);
    return {
      id: r.id,
      subject: r.subject,
      source: r.source,
      exam_year: label.year,
      exam_authority: label.authority,
      exam_district: label.district,
      exam_set: label.set,
      exam_question_no: label.questionNo,
    };
  });

  const withYear = updates.filter((u) => u.exam_year !== null).length;
  const withAuthority = updates.filter((u) => u.exam_authority !== null).length;
  const withBoth = updates.filter((u) => u.exam_year !== null && u.exam_authority !== null).length;
  console.log(`  year parsed:      ${withYear}/${rows.length}`);
  console.log(`  authority parsed: ${withAuthority}/${rows.length}`);
  console.log(`  both:             ${withBoth}/${rows.length}`);

  if (dryRun) {
    console.log("\nSample of what would be written:");
    for (const u of updates.slice(0, 8)) {
      console.log(
        `  ${String(u.source).slice(0, 44).padEnd(46)} -> ${u.exam_authority ?? "-"} / ${u.exam_year ?? "-"}` +
          `${u.exam_district ? ` / ${u.exam_district}` : ""}${u.exam_set ? ` / Set ${u.exam_set}` : ""} / Q${u.exam_question_no ?? "-"}`,
      );
    }
    return;
  }

  // Bulk UPDATE through the apply_exam_labels RPC. PostgREST's .upsert() was
  // tried and cannot work here: it INSERTs first, so a partial column list
  // trips the NOT NULL constraints on columns this backfill has no business
  // writing (exam_board, subject, embedding...). The RPC takes the batch as one
  // jsonb array and updates in a single statement.
  let done = 0;
  for (let i = 0; i < updates.length; i += WRITE_BATCH) {
    const batch = updates.slice(i, i + WRITE_BATCH).map((u) => ({
      id: u.id,
      exam_year: u.exam_year,
      exam_authority: u.exam_authority,
      exam_district: u.exam_district,
      exam_set: u.exam_set,
      exam_question_no: u.exam_question_no,
    }));
    const { data, error } = await supabase.rpc("apply_exam_labels", { labels: batch });
    if (error) {
      console.error(`batch starting at ${i} failed`, error);
      process.exitCode = 1;
      return;
    }
    if (data !== batch.length) {
      console.warn(`\n  batch at ${i}: sent ${batch.length} rows, RPC updated ${data}`);
    }
    done += batch.length;
    process.stdout.write(`\r  written ${done}/${updates.length}`);
  }
  console.log("\ndone.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
