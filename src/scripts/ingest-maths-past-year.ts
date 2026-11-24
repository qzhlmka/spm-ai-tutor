/**
 * Ingests the Mathematics SELEKOH question book, pairing each question with its
 * answer from the separate SKEMA KERTAS answer-key PDFs.
 *
 * Neither half is usable alone: the question book prints no answers (verified by
 * rendering a page — clean two-column, nothing highlighted, unlike the Sejarah
 * SKEMA files), and ingesting an answer key by itself produced chunks reading
 * "Soalan 1: Jawapan: C" with no question attached. Under the chunker's
 * anti-fabrication rule the question book alone yields nothing at all, which is
 * why Mathematics had zero past_year_question chunks.
 *
 * Pairing key is (form, chapter, question number). The question book numbers
 * questions from 1 within each BAB and the answer key is grouped the same way,
 * but a BAB heading only appears where a chapter STARTS — so a page in the
 * middle of a chapter carries no marker of which chapter it is in. The chapter
 * for every page is therefore tracked by walking the text layer in order and
 * carrying the last heading forward, and pages are then grouped by chapter so
 * each ingestion run is handed exactly the answer key that applies to it.
 */
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir } from "node:fs/promises";
import { extractPagesVision } from "../ingest/vision-extract.js";
import { runIngestion } from "../ingest/ingest.js";
import { parseAnswerKey, type AnswerKeyChapter } from "./parse-answer-key.js";

const execFileAsync = promisify(execFile);

/** Chapter titles differ slightly between the two PDFs ("DAN" vs "&", spacing),
 * so chapters are identified by a distinctive keyword rather than exact title.
 * `topic` maps onto the vocabulary the Mathematics textbook chunks already use;
 * where a chapter legitimately spans two of those topics, all candidates are
 * passed so each chunk picks its own. */
const CHAPTERS: { form: 4 | 5; bab: number; match: RegExp; topic: string | string[] }[] = [
  { form: 4, bab: 1, match: /kuadratik/i, topic: "Quadratic Functions and Equations in One Variable" },
  { form: 4, bab: 2, match: /asas\s*nombor/i, topic: "Number Bases" },
  { form: 4, bab: 3, match: /penaakulan\s*logik/i, topic: "Logical Reasoning" },
  { form: 4, bab: 4, match: /operasi\s*set/i, topic: "Operations on Sets" },
  { form: 4, bab: 5, match: /rangkaian/i, topic: "Network in Graph Theory" },
  { form: 4, bab: 6, match: /ketaksamaan/i, topic: "Linear Inequalities in Two Variables" },
  { form: 4, bab: 7, match: /graf\s*gerakan/i, topic: "Graphs of Motion" },
  { form: 4, bab: 8, match: /sukatan\s*serakan/i, topic: ["Measures of Dispersion for Grouped Data", "Measures of Dispersion for Ungrouped Data"] },
  { form: 4, bab: 9, match: /kebarangkalian/i, topic: "Probability of Combined Events" },
  { form: 4, bab: 10, match: /pengurusan\s*kewangan/i, topic: "Consumer Mathematics: Financial Management" },
  { form: 5, bab: 1, match: /ubahan/i, topic: "Variation" },
  { form: 5, bab: 2, match: /matriks/i, topic: "Matrices" },
  { form: 5, bab: 3, match: /insurans/i, topic: "Consumer Mathematics: Insurance" },
  { form: 5, bab: 4, match: /cukai/i, topic: "Consumer Mathematics: Taxation" },
  { form: 5, bab: 5, match: /kekongruenan|kekongrunan|transformasi/i, topic: "Congruency, Enlargement and Combined Transformations" },
  { form: 5, bab: 6, match: /trigonometri/i, topic: "Ratios and Graphs of Trigonometric Functions" },
];

type Chapter = (typeof CHAPTERS)[number];

async function textPages(pdfPath: string): Promise<string[]> {
  const { stdout } = await execFileAsync("pdftotext", ["-layout", pdfPath, "-"], { maxBuffer: 50 * 1024 * 1024 });
  // pdftotext terminates the last page with a form feed too, so splitting yields a
  // trailing empty element. Harmless for alignment (it is at the end), but it makes
  // the page count disagree with the renderer's and trips the mismatch warning
  // below — which would then be ignored on the run where it actually means
  // something. Drop it here instead.
  const pages = stdout.split("\f");
  while (pages.length > 0 && pages[pages.length - 1].trim() === "") pages.pop();
  return pages;
}

/** Index i = chapter that page i belongs to (null before the first heading). */
function assignChapters(pages: string[]): (Chapter | null)[] {
  let current: Chapter | null = null;
  return pages.map((page) => {
    // A page can open one chapter and continue another in the second column, so
    // the LAST heading on the page wins — that is the one the rest of the page,
    // and every page after it, belongs to.
    for (const m of page.matchAll(/BAB\s*(\d+)\s*[:.]?\s*([^\n]{0,80})/gi)) {
      const bab = Number(m[1]);
      const title = m[2];
      const hit = CHAPTERS.find((c) => c.bab === bab && c.match.test(title));
      if (hit) current = hit;
    }
    return current;
  });
}

async function main() {
  const book = process.argv[2];
  const keyF4 = process.argv[3];
  const keyF5 = process.argv[4];
  if (!book || !keyF4 || !keyF5) {
    throw new Error("Usage: tsx src/scripts/ingest-maths-past-year.ts <selekoh.pdf> <kertas1-f4.pdf> <kertas1-f5.pdf> [--dry-run]");
  }
  const dryRun = process.argv.includes("--dry-run");

  const keys = new Map<string, AnswerKeyChapter>();
  for (const [form, keyPath] of [[4, keyF4], [5, keyF5]] as const) {
    for (const ch of await parseAnswerKey(keyPath)) keys.set(`${form}:${ch.bab}`, ch);
  }
  console.log(`Answer keys: ${keys.size} chapters, ${[...keys.values()].reduce((s, c) => s + c.answers.size, 0)} answers.`);

  const assigned = assignChapters(await textPages(book));
  const counts = new Map<string, number>();
  for (const c of assigned) counts.set(c ? `F${c.form} BAB ${c.bab}` : "(unassigned)", (counts.get(c ? `F${c.form} BAB ${c.bab}` : "(unassigned)") ?? 0) + 1);
  console.log("Pages per chapter:");
  for (const [k, v] of counts) console.log(`  ${k}: ${v}`);

  if (dryRun) { console.log("\nDry run — no OCR, no writes."); return; }

  const cacheDir = path.join(".ocr-cache", "maths-selekoh");
  await mkdir(cacheDir, { recursive: true });
  const ocr = await extractPagesVision(book, cacheDir);
  if (ocr.length !== assigned.length) {
    console.warn(`WARNING: ${ocr.length} OCR pages vs ${assigned.length} text pages — chapter alignment may be off.`);
  }

  const sourceFile = path.basename(book);
  let total = 0;
  for (const chapter of CHAPTERS) {
    const pages = ocr.filter((_, i) => assigned[i]?.form === chapter.form && assigned[i]?.bab === chapter.bab);
    if (pages.length === 0) continue;
    const key = keys.get(`${chapter.form}:${chapter.bab}`);
    if (!key) {
      console.log(`F${chapter.form} BAB ${chapter.bab}: ${pages.length} pages but NO answer key — skipping (questions with no answers get dropped anyway).`);
      continue;
    }
    const topics = Array.isArray(chapter.topic) ? chapter.topic : [chapter.topic];
    console.log(`\nF${chapter.form} BAB ${chapter.bab} -> ${topics.join(" | ")} (${pages.length} pages, ${key.answers.size} answers)`);
    const { chunkCount } = await runIngestion({
      pages,
      examBoard: "SPM",
      subject: "Mathematics",
      topic: topics[0],
      topicOptions: topics.length > 1 ? topics : undefined,
      answerKey: key.answers,
      sourceFile,
    });
    total += chunkCount;
    console.log(`  ${chunkCount} chunks (running total ${total})`);
  }
  console.log(`\nDone. ${total} chunks.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
