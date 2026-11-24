/**
 * Removes answer letters that point at nothing, leaving the question intact.
 *
 * THE DEFECT. Two separate ingestion bugs left past-year chunks ending in a
 * bare "Jawapan: C" / "Answer: A" on a question that offers no lettered options
 * to map the letter onto:
 *
 *  - Mathematics (~165, MATEMATIK BUKU SELEKOH). The answer key is KERTAS 1 —
 *    Paper 1, which is MCQ-only — but the book holds Paper 1 AND Paper 2, both
 *    numbered from 1, and the pairing matched on printed number alone. A 3-mark
 *    "determine the maximum point of P" was stored with Paper 1 question 12's
 *    letter.
 *  - Physics (~86, FIZIK BUKU SELEKOH). Here the letter is probably right and
 *    the QUESTION is broken: these papers lay their options out in a diagram or
 *    table, OCR rendered them as prose, and the A-D block never reached the
 *    stored text. 20 of them have no question sentence left at all.
 *
 * WHY STRIPPING RATHER THAN DELETING. The questions themselves are real and
 * worth keeping; only the answer is unusable. The tutor is strictly grounded,
 * but GROUNDING distinguishes facts from reasoning — it may not assert an
 * official answer that isn't in the material, and it may work the question
 * through with the student using a retrieved method. So an answerless past-year
 * question is still teachable; a question carrying a confidently wrong letter is
 * not, because the letter is the one thing the tutor is obliged to repeat.
 *
 * This deliberately overrides the pipeline's own rule that a past-year question
 * with no in-source answer is dropped at ingestion. That rule is about what to
 * ADMIT; these rows are already admitted and their questions have value. New
 * ingestions are unaffected — `looksLikeMcq()` in ingest.ts now prevents a key
 * letter from ever being attached to a non-MCQ in the first place.
 *
 * Re-embeds every row it edits: `content` feeds passageTextForChunk(), so
 * leaving the old vector would make retrieval reflect text that is no longer
 * stored.
 *
 *   npx tsx --env-file=.env src/scripts/strip-unusable-answers.ts [--dry-run]
 */
import { embedPassage } from "../lib/embeddings.js";
import { passageTextForChunk } from "../lib/chunk-embedding-text.js";
import { supabase } from "../lib/supabase.js";

const PAGE = 1000;

interface Row {
  id: string;
  subject: string;
  topic: string;
  content: string;
  source: string | null;
  source_file: string | null;
}

/** An answer line that is a letter and nothing else. A line that also spells the
 * answer out ("Jawapan: A Ikatan ion") is left alone — the words are the answer,
 * and they work whether or not the option list survived OCR. This is why
 * Chemistry and Sejarah come out of this untouched. */
const BARE_ANSWER_LINE = /(^|\n)[ \t]*(?:Jawapan|Answer)[ \t]*:[ \t]*[A-D][ \t]*(?=\n|$)/gim;

/** Counts how many distinct option labels the text presents. Accepts "A." /
 * "A)" / "A]" and "A <text>" at line start, so a 2- or 3-option question still
 * registers — several genuine Chemistry MCQs only captured A-C. */
function optionCount(content: string): number {
  return (["A", "B", "C", "D"] as const).filter((letter) =>
    new RegExp(String.raw`(^|\n)\s*${letter}\s*[.)\]]|(^|\n)\s*${letter}\s+\S`, "m").test(content),
  ).length;
}

function isUnusable(content: string): boolean {
  BARE_ANSWER_LINE.lastIndex = 0;
  return BARE_ANSWER_LINE.test(content) && optionCount(content) < 2;
}

function strip(content: string): string {
  BARE_ANSWER_LINE.lastIndex = 0;
  return content.replace(BARE_ANSWER_LINE, "").trimEnd();
}

async function loadAll(): Promise<Row[]> {
  const rows: Row[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("content_chunks")
      .select("id, subject, topic, content, source, source_file")
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
  const targets = rows.filter((r) => isUnusable(r.content));

  const bySubject = new Map<string, number>();
  for (const t of targets) bySubject.set(t.subject, (bySubject.get(t.subject) ?? 0) + 1);
  console.log(`past-year chunks: ${rows.length}`);
  console.log(`unusable answer letters: ${targets.length}${dryRun ? "  (dry run — nothing will be written)" : ""}`);
  for (const [subject, n] of [...bySubject].sort((a, b) => b[1] - a[1])) console.log(`   ${subject.padEnd(14)} ${n}`);

  // A stripped chunk must still be a question. If stripping leaves almost
  // nothing, the row was never a usable question and silently turning it into a
  // fragment is worse than leaving it — report those instead of editing them.
  const wouldEmpty = targets.filter((t) => strip(t.content).trim().length < 40);
  if (wouldEmpty.length > 0) {
    console.log(`\nNOTE: ${wouldEmpty.length} rows would be left under 40 chars after stripping — skipped, listed below:`);
    for (const t of wouldEmpty.slice(0, 5)) console.log(`   ${t.source ?? "(no source)"}: ${JSON.stringify(t.content.slice(0, 60))}`);
  }
  const editable = targets.filter((t) => strip(t.content).trim().length >= 40);

  if (dryRun) {
    console.log(`\nWould edit ${editable.length} rows. Sample:`);
    for (const t of editable.slice(0, 3)) {
      console.log(`\n--- ${t.source ?? "(no source)"} [${t.subject}] ---`);
      console.log(`BEFORE (tail): ${JSON.stringify(t.content.slice(-70))}`);
      console.log(`AFTER  (tail): ${JSON.stringify(strip(t.content).slice(-70))}`);
    }
    return;
  }

  let done = 0;
  for (const t of editable) {
    const content = strip(t.content);
    const embedding = await embedPassage(
      passageTextForChunk({ content_type: "past_year_question", subject: t.subject, topic: t.topic, content }),
    );
    const { error } = await supabase.from("content_chunks").update({ content, embedding }).eq("id", t.id);
    if (error) {
      console.error(`\nrow ${t.id} failed`, error);
      process.exitCode = 1;
      return;
    }
    done++;
    if (done % 25 === 0) process.stdout.write(`\r  edited ${done}/${editable.length}`);
  }
  console.log(`\ndone — ${done} rows stripped and re-embedded.`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
