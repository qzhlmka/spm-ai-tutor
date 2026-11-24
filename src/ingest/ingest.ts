import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
// @ts-ignore — pdf-parse has no ESM-friendly types for the pagerender option
import pdfParse from "pdf-parse";
import { openai, CHUNKING_MODEL } from "../lib/openai.js";
import { embedPassage } from "../lib/embeddings.js";
import { passageTextForChunk } from "../lib/chunk-embedding-text.js";
import { supabase } from "../lib/supabase.js";
import { CHUNKING_SYSTEM_PROMPT, buildChunkingUserPrompt } from "./chunking-prompt.js";
import { extractPagesVision, pageImagePathsFor } from "./vision-extract.js";
import { parseExamLabel } from "../lib/exam-label.js";

export const PAGES_PER_BATCH = 6;

interface RawChunk {
  content_type: "concept" | "worked_example" | "past_year_question" | "formula" | "common_mistake";
  difficulty: "easy" | "medium" | "hard";
  subtopic: string | null;
  source_note: string | null;
  answer_status: "in_source" | "not_in_source";
  content: string;
  /** Only present when runIngestion was given topicOptions. */
  topic?: string | null;
  /** Only present when runIngestion was given an answerKey — the number printed
   * beside the question in the source, used to look its answer up in code. */
  question_number?: number | null;
}

interface CliArgs {
  file: string;
  examBoard: string;
  subject: string;
  topic: string;
  dryRun: boolean;
  startPage?: number;
  endPage?: number;
  vision: boolean;
  /** Pull the subject's existing topics from the DB and let each chunk pick its
   * own, for whole-syllabus sources like a past-year revision book. */
  topicsFromDb: boolean;
  /** A question bank published without its answers: keep every question and
   * mark it unanswered instead of dropping it. See QUESTIONS_ONLY_NOTE. */
  questionsOnly: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: Record<string, string> = {};
  let dryRun = false;
  let vision = false;
  let topicsFromDb = false;
  let questionsOnly = false;
  let filePath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") { dryRun = true; continue; }
    if (a === "--vision") { vision = true; continue; }
    if (a === "--topics-from-db") { topicsFromDb = true; continue; }
    if (a === "--questions-only") { questionsOnly = true; continue; }
    if (a.startsWith("--")) { args[a.slice(2)] = argv[i + 1]; i++; continue; }
    filePath ??= a;
  }
  if (!filePath) throw new Error("Usage: npm run ingest -- <file.pdf> --exam-board SPM --subject 'Add Maths' --topic Differentiation [--start-page N] [--end-page N] [--vision] [--topics-from-db] [--questions-only] [--dry-run]");
  if (!args["exam-board"]) throw new Error("Missing --exam-board");
  if (!args["subject"]) throw new Error("Missing --subject");
  if (!args["topic"]) throw new Error("Missing --topic");

  const startPage = args["start-page"] ? Number(args["start-page"]) : undefined;
  const endPage = args["end-page"] ? Number(args["end-page"]) : undefined;
  if (startPage !== undefined && (!Number.isInteger(startPage) || startPage < 1)) {
    throw new Error("--start-page must be a positive integer");
  }
  if (endPage !== undefined && (!Number.isInteger(endPage) || endPage < 1)) {
    throw new Error("--end-page must be a positive integer");
  }
  if (startPage !== undefined && endPage !== undefined && startPage > endPage) {
    throw new Error("--start-page must be <= --end-page");
  }

  return {
    file: filePath,
    examBoard: args["exam-board"],
    subject: args["subject"],
    topic: args["topic"],
    dryRun,
    startPage,
    endPage,
    vision,
    topicsFromDb,
    questionsOnly,
  };
}

/** The topic list offered to the chunker is the set already in use for this
 * subject, so a new source files itself alongside existing content instead of
 * inventing a parallel vocabulary. */
async function existingTopicsFor(subject: string): Promise<string[]> {
  // PostgREST caps a response at db-max-rows (1000 by default) and .range() cannot
  // raise it — a single select returned only 10 of Mathematics' 18 topics, and a
  // short list here silently pushes chunks onto the fallback topic instead of their
  // real one. So page through explicitly, with a stable order so pages don't overlap.
  const PAGE = 1000;
  const seen = new Set<string>();
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await supabase
      .from("content_chunks")
      .select("topic")
      .eq("subject", subject)
      .order("id")
      .range(offset, offset + PAGE - 1);
    if (error) throw new Error(`Could not read existing topics for ${subject}: ${error.message}`);
    for (const r of data ?? []) if (r.topic) seen.add(r.topic as string);
    if (!data || data.length < PAGE) break;
  }
  const topics = [...seen].sort();
  if (topics.length === 0) throw new Error(`No existing topics for subject "${subject}" — ingest without --topics-from-db.`);
  return topics;
}

export async function extractPagesFromBuffer(buffer: Buffer, startPage?: number, endPage?: number): Promise<string[]> {
  const pages: string[] = [];
  await pdfParse(buffer, {
    pagerender: (pageData: any) =>
      pageData.getTextContent().then((textContent: any) => {
        const text = textContent.items.map((item: any) => item.str).join(" ");
        pages.push(text);
        return text;
      }),
  });
  if (startPage === undefined && endPage === undefined) return pages;
  const from = (startPage ?? 1) - 1;
  const to = endPage ?? pages.length;
  return pages.slice(from, to);
}

async function extractPages(filePath: string, startPage?: number, endPage?: number): Promise<string[]> {
  const buffer = await readFile(filePath);
  return extractPagesFromBuffer(buffer, startPage, endPage);
}

// Heuristic for "this pdf-parse text layer is unusable" — scanned pages and
// pages exported as flattened images extract as near-empty text; pages with a
// broken/custom font embedding extract as dense but meaningless glyph
// gibberish. Both cases still return *some* characters, so a single overall
// length check isn't enough — near-empty-page ratio catches the first case,
// average density catches neither alone catching a deck that's mostly normal
// with a few bad pages, so either signal alone is enough to flag it.
const NEAR_EMPTY_PAGE_CHARS = 20;
const NEAR_EMPTY_PAGE_FRACTION = 0.3;
const MIN_AVG_CHARS_PER_PAGE = 200;

export function looksLikeScannedText(pages: string[]): boolean {
  if (pages.length === 0) return false;
  const totalChars = pages.reduce((sum, p) => sum + p.trim().length, 0);
  const nearEmptyPages = pages.filter((p) => p.trim().length < NEAR_EMPTY_PAGE_CHARS).length;
  return nearEmptyPages / pages.length > NEAR_EMPTY_PAGE_FRACTION || totalChars / pages.length < MIN_AVG_CHARS_PER_PAGE;
}

function batchPages(pages: string[], size: number): string[] {
  const batches: string[] = [];
  for (let i = 0; i < pages.length; i += size) {
    batches.push(pages.slice(i, i + size).join("\n\n"));
  }
  return batches;
}

const CHUNK_BATCH_ATTEMPTS = 3;

class ChunkOutputTooLongError extends Error {}

async function chunkBatch(batchText: string, topicOptions?: string[], hasAnswerKey?: boolean, questionsOnly?: boolean): Promise<RawChunk[]> {
  for (let attempt = 1; ; attempt++) {
    const completion = await openai.chat.completions.create({
      model: CHUNKING_MODEL,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: CHUNKING_SYSTEM_PROMPT },
        { role: "user", content: buildChunkingUserPrompt(batchText, topicOptions, hasAnswerKey, questionsOnly) },
      ],
    });
    const raw = completion.choices[0].message.content ?? "{}";
    const finishReason = completion.choices[0].finish_reason;
    try {
      return JSON.parse(raw).chunks ?? [];
    } catch (err) {
      // Hitting the output cap is a property of the input, not bad luck —
      // repeating the same request just pays for the same truncation again.
      // chunkPages() handles it by splitting the batch instead.
      if (finishReason === "length") throw new ChunkOutputTooLongError("chunking output hit the length limit");
      if (attempt >= CHUNK_BATCH_ATTEMPTS) throw err;
      console.warn(`  Chunking response was not valid JSON (finish_reason: ${finishReason}), retrying ${attempt}/${CHUNK_BATCH_ATTEMPTS - 1}...`);
    }
  }
}

/** Chunks a page batch, halving it when the model's output can't fit in one
 * response — measured on Chemistry Form 5 KSSM pages 31-36, which hit the
 * length limit on every attempt. Splitting can separate a question from a
 * solution on the other side of the cut, so it's only the fallback. */
/** Vision OCR sometimes transcribes a dashed or dotted line as thousands of
 * "- - -" characters (Physics F5 module p.112, a diagram legend: 7k of its 9k
 * characters). The chunker copies the run into its output and hits the length
 * limit on every split down to that single page, so the page could not be
 * ingested at all. A run of 20+ repeated marks carries nothing; only the text
 * sent to the chunker is collapsed, not the page text chunks are matched against. */
function collapseMarkRuns(text: string): string {
  return text.replace(/(?:[-–—_.·•=*~] ?){20,}/g, "- - - ");
}

async function chunkPages(pages: string[], topicOptions?: string[], hasAnswerKey?: boolean, questionsOnly?: boolean): Promise<RawChunk[]> {
  try {
    return await chunkBatch(collapseMarkRuns(pages.join("\n\n")), topicOptions, hasAnswerKey, questionsOnly);
  } catch (err) {
    if (!(err instanceof ChunkOutputTooLongError) || pages.length < 2) throw err;
    const mid = Math.ceil(pages.length / 2);
    console.warn(`  Chunking output too long for ${pages.length} pages, splitting into ${mid} + ${pages.length - mid}...`);
    return [
      ...(await chunkPages(pages.slice(0, mid), topicOptions, hasAnswerKey, questionsOnly)),
      ...(await chunkPages(pages.slice(mid), topicOptions, hasAnswerKey, questionsOnly)),
    ];
  }
}

// The chunk → embed → insert core, shared by the CLI (below) and the teacher
// upload path (src/lib/materials.ts) so there's one implementation, not two
// drifting copies. Inserts are batched per page-batch (one `insert(rows[])`
// call instead of one row at a time) rather than a behavior change.

/** A chunk's own topic wins, but only if it is genuinely one of the offered
 * options — the model occasionally returns a near-miss spelling, and letting
 * that through is exactly how a parallel topic vocabulary gets created. */
function chunkTopic(c: RawChunk, opts: { topic: string; topicOptions?: string[] }): string {
  if (!opts.topicOptions?.length) return opts.topic;
  return c.topic && opts.topicOptions.includes(c.topic) ? c.topic : opts.topic;
}

/** Does this chunk actually present multiple-choice options A-D?
 *
 * Used to decide whether a letter from an answer key may be attached at all.
 * Deliberately requires all four labels on their own lines: a structured
 * question routinely mentions "A" or "B" mid-sentence (point A, diagram B), and
 * a looser test would readmit exactly the false positives this exists to stop. */
export function looksLikeMcq(content: string): boolean {
  return (["A", "B", "C", "D"] as const).every((letter) =>
    new RegExp(String.raw`(^|\n)\s*${letter}\s*[.)\]]`, "m").test(content),
  );
}

function normalizeForPageMatch(s: string): string {
  return s.replace(/[^a-z0-9]+/gi, " ").trim().toLowerCase();
}

/** Which page(s), within the SAME batch the chunk was chunked from, its text
 * actually came from — so a chunk's source_page_images can point at the one
 * or two pages it needs, not the whole 6-page batch. Matches on a shrinking
 * prefix of the chunk's own content (not source_note, which is model-authored
 * and may not appear verbatim on the page) against each page's raw OCR text,
 * since content is the one field that's largely a direct transcription.
 *
 * Returns [] rather than guessing when nothing matches (e.g. the chunking
 * model paraphrased more than expected) — an untagged chunk just has no image
 * to attach later, the same "optional at runtime" degrade as everywhere else
 * this feature touches, rather than risking the wrong page's diagram being
 * shown as if it were this question's. Includes the following page too: the
 * ingestion pipeline's own chunking rule allows a question's solution (or,
 * for a diagram, its continuation) to land on a later page than the question. */
export function matchingPageIndices(chunkContent: string, batchPageTexts: string[]): number[] {
  const words = normalizeForPageMatch(chunkContent).split(" ").filter(Boolean);
  // Offset 0 first, then a few words in. A stored chunk routinely opens with
  // a label the chunking model added ("Question:", "Marking Scheme:") that
  // never appeared on the actual page — anchoring only at offset 0 would
  // build a needle out of that label and never find it, failing shut on
  // exactly the past-year chunks this feature exists for. Trying a few
  // offsets is robust to an unknown scaffold vocabulary without having to
  // enumerate every label the chunker might use.
  for (const offset of [0, 2, 4, 6]) {
    for (const len of [10, 6]) {
      if (words.length < offset + len) continue;
      const needle = words.slice(offset, offset + len).join(" ");
      const idx = batchPageTexts.findIndex((t) => normalizeForPageMatch(t).includes(needle));
      if (idx !== -1) return idx + 1 < batchPageTexts.length ? [idx, idx + 1] : [idx];
    }
  }

  // Fallback for chunks the pass above still misses — measured, concentrated
  // in chunks describing a hand-drawn diagram/electron-arrangement/mechanism
  // in the chunking model's own notation rather than quoting the page, so no
  // 6-10 word run survives verbatim. A shorter (4-word) window finds these,
  // but is also far more likely to appear on more than one page by chance —
  // so unlike the pass above, a short needle is only trusted when it matches
  // EXACTLY ONE page in the batch. Multiple hits means "can't tell which
  // one", and that's still a fail-empty, not a guess.
  for (const offset of [0, 2, 4, 6, 8]) {
    const len = 4;
    if (words.length < offset + len) continue;
    const needle = words.slice(offset, offset + len).join(" ");
    const hits = batchPageTexts
      .map((t, i) => (normalizeForPageMatch(t).includes(needle) ? i : -1))
      .filter((i) => i !== -1);
    if (hits.length === 1) {
      const idx = hits[0];
      return idx + 1 < batchPageTexts.length ? [idx, idx + 1] : [idx];
    }
  }
  return [];
}

/** Uploads the matched local page images to the private 'exam-page-images'
 * bucket and returns their storage paths, for source_page_images — see
 * migrate_add_exam_page_images.sql. `upsert: true` makes re-ingesting the same
 * file (a documented, supported operation — see the source_file column's own
 * comment) safe to re-run without accumulating duplicate objects. Only pages
 * actually matched to a chunk are uploaded, not every rendered page in the
 * batch, so a source with no diagram-bearing questions costs nothing here. */
export async function uploadPageImages(
  storagePrefix: string,
  localImagePaths: string[],
  pageIndices: number[],
  batchOffset: number,
): Promise<string[]> {
  const paths: string[] = [];
  for (const idx of pageIndices) {
    const localPath = localImagePaths[idx];
    if (!localPath) continue;
    // idx is local to this batch's own slice (0..PAGES_PER_BATCH-1) — the
    // filename must be the document-global page number, or two different
    // batches' local index 0 collide on the same "page-0001.png" storage
    // path (upsert overwrites it), silently repointing every earlier chunk
    // that matched there at the wrong page. Verified this had already
    // happened on real ingested data before this fix.
    const storagePath = `${storagePrefix}/page-${String(batchOffset + idx + 1).padStart(4, "0")}.png`;
    const bytes = await readFile(localPath);
    const { error } = await supabase.storage
      .from("exam-page-images")
      .upload(storagePath, bytes, { contentType: "image/png", upsert: true });
    if (error) {
      console.warn(`Failed to upload page image ${storagePath}: ${error.message}`);
      continue;
    }
    paths.push(storagePath);
  }
  return paths;
}

export async function runIngestion(opts: {
  pages: string[];
  examBoard: string;
  subject: string;
  topic: string;
  materialId?: string;
  /** When set, each chunk picks its own topic from this list and `topic` above
   * is only the fallback for chunks the model couldn't place. */
  topicOptions?: string[];
  /** Answers published in a separate file from the questions, keyed by the
   * question number printed in the source. Applied in code after chunking — see
   * the keyRule comment in chunking-prompt.ts for why not in the prompt. */
  answerKey?: Map<number, string>;
  /** Basename of the PDF these pages came from, recorded on every row so the
   * knowledge base can be audited and re-ingested per file. See
   * sql/migrate_add_chunk_source_file.sql. */
  sourceFile?: string;
  /** Local paths of each page rendered to an image (--vision only), same
   * length and order as `pages`. Lets a chunk that references a diagram carry
   * a pointer to the real source page instead of only a text description of
   * it — see migrate_add_exam_page_images.sql and matchingPageIndices() above.
   * Omitted entirely for the non-vision text-layer path, where there is no
   * rendered image to point at. */
  pageImages?: string[];
  /** Real page number of pages[0] in the source PDF (the CLI's --start-page).
   * Page-image filenames must use it, or resuming a file from page 31 saves
   * page 31's image as page-0001.png and overwrites page 1's. */
  firstPageNumber?: number;
  /** The source is a question bank with no answers anywhere in it (the
   * Selekoh 2026 Chemistry modules). Unanswered past-year questions are kept
   * and marked rather than dropped. */
  questionsOnly?: boolean;
}): Promise<{ chunkCount: number }> {
  const batches = batchPages(opts.pages, PAGES_PER_BATCH);
  // Storage path prefix for uploaded page images — one real source PDF or
  // teacher upload should own one folder, so re-ingesting the same file (a
  // supported, documented operation) overwrites rather than accumulating.
  const imageStoragePrefix = opts.materialId
    ? `materials/${opts.materialId}`
    : opts.sourceFile
      ? `sources/${opts.sourceFile.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")}`
      : null;
  let chunkCount = 0;

  for (let i = 0; i < batches.length; i++) {
    console.log(`Chunking batch ${i + 1}/${batches.length}...`);
    const batchPageTexts = opts.pages.slice(i * PAGES_PER_BATCH, (i + 1) * PAGES_PER_BATCH);
    const rawChunks = await chunkPages(batchPageTexts, opts.topicOptions, Boolean(opts.answerKey), opts.questionsOnly);
    const batchPageImages = opts.pageImages?.slice(i * PAGES_PER_BATCH, (i + 1) * PAGES_PER_BATCH);

    // Attach official answers by exact printed question number. A question whose
    // number isn't in the key keeps answer_status "not_in_source" and is dropped
    // below — the same fate as before, and far better than guessing at which key
    // entry was meant.
    if (opts.answerKey) {
      for (const c of rawChunks) {
        if (c.content_type !== "past_year_question") continue;
        const answer = typeof c.question_number === "number" ? opts.answerKey.get(c.question_number) : undefined;
        if (!answer) continue;

        // A letter answer is meaningless unless the question actually offers
        // lettered options, so the chunk must look like an MCQ before the key
        // is allowed near it. Without this guard the pairing is only as safe as
        // the assumption that the question file and the key cover the same set
        // of questions — and that assumption has now failed twice, the same way
        // both times. A question bank prints Paper 1 (MCQ, 1..N) and Paper 2
        // (structured, also 1..N) in one file; the key covers Paper 1 alone;
        // matching on the number alone staples an MCQ letter onto a structured
        // question. Measured on MATEMATIK BUKU SELEKOH: 168 of 398 stored
        // chunks ended up with a "Jawapan: B" on a multi-part "[3 Markah]"
        // working question. The Chemistry class notes failed identically
        // (see CLAUDE.md) — there it was caught by an audit, here it reached
        // students. This check is cheap, local, and would have stopped both.
        if (!looksLikeMcq(c.content)) {
          console.warn(
            `Q${c.question_number}: key says ${answer} but the question presents no A-D options — not an MCQ, leaving it unanswered.`,
          );
          continue;
        }

        // The page may ALREADY carry an answer — a teacher's handwritten working,
        // or a marked option. Appending blindly produced chunks ending in two
        // contradicting lines ("Jawapan: D — Prisma" then "Jawapan: C"), which is
        // strictly worse than either answer alone: the student sees both and can
        // tell which is right only by already knowing. The published scheme is the
        // authority, so an existing bare MCQ answer line is replaced, not kept.
        // Only a bare "Jawapan: <letter>" declaration is stripped — prose answers
        // and per-part working in a structured question are left alone.
        const existing = c.content.match(/^[ \t]*Jawapan\s*:\s*([A-D])\b.*$/im);
        if (existing && existing[1] !== answer) {
          console.warn(`Q${c.question_number}: page says ${existing[1]}, official scheme says ${answer} — using the scheme.`);
        }
        const stripped = c.content.replace(/^[ \t]*Jawapan\s*:\s*[A-D]\b.*$/gim, "").trimEnd();
        c.content = `${stripped}\n\nJawapan: ${answer}`;
        c.answer_status = "in_source";
      }
    }
    if (rawChunks.length === 0) continue;

    // A past-year question with no answer actually present in the source is
    // worse than useless for retrieval — the chunking model tends to fill the
    // gap with a fabricated or hedged answer, which then gets surfaced to
    // students as authoritative. Drop those rather than insert them.
    // --questions-only says the file holds no answers at all, so any answer
    // line on a question was supplied by a model, not the page. Stripped in
    // code because the prompt alone did not hold: on the Selekoh 2026
    // Chemistry modules the chunker still wrote "Jawapan: X" on 6 of 469
    // questions, two of them after vision OCR reported a highlight the page
    // does not have, and one of the six was the wrong option.
    if (opts.questionsOnly) {
      for (const c of rawChunks) {
        if (c.content_type !== "past_year_question") continue;
        const stripped = stripAnswerLines(c.content);
        if (stripped !== c.content) console.warn(`Removed an answer line the source does not contain: ${c.source_note ?? "(no source_note)"}`);
        c.content = stripped;
        c.answer_status = "not_in_source";
      }
    }
    const chunks = rawChunks.filter((c) => {
      if (c.content_type === "past_year_question" && c.answer_status === "not_in_source") {
        if (opts.questionsOnly) return true;
        console.warn(`Dropping past_year_question chunk with no in-source answer: ${c.source_note ?? "(no source_note)"}`);
        return false;
      }
      return true;
    });
    if (chunks.length === 0) continue;

    const rows = [];
    for (const c of chunks) {
      let sourcePageImages: string[] | null = null;
      if (imageStoragePrefix && batchPageImages && batchPageImages.length > 0) {
        const pageIndices = matchingPageIndices(c.content, batchPageTexts);
        if (pageIndices.length > 0) {
          const uploaded = await uploadPageImages(
            imageStoragePrefix,
            batchPageImages,
            pageIndices,
            (opts.firstPageNumber ?? 1) - 1 + i * PAGES_PER_BATCH,
          );
          if (uploaded.length > 0) sourcePageImages = uploaded;
        }
      }
      // The exam identity (state/year/question) is parsed from the source label
      // here, at insert time. It used to be filled only by
      // backfill-exam-labels.ts, so everything ingested after that run —
      // including every Chemistry re-ingestion and teacher upload — had none,
      // and the exam lane told students "I don't have Negeri Sembilan 2022"
      // while holding it. Not part of the embedded text, so this costs nothing.
      const examLabel = c.content_type === "past_year_question" ? parseExamLabel(c.source_note) : null;
      rows.push({
        exam_year: examLabel?.year ?? null,
        exam_authority: examLabel?.authority ?? null,
        exam_district: examLabel?.district ?? null,
        exam_set: examLabel?.set ?? null,
        exam_question_no: examLabel?.questionNo ?? null,
        exam_board: opts.examBoard,
        subject: opts.subject,
        topic: chunkTopic(c, opts),
        subtopic: c.subtopic,
        content_type: c.content_type,
        difficulty: c.difficulty,
        content: storedContent(c, opts.questionsOnly),
        source: c.source_note,
        material_id: opts.materialId ?? null,
        source_file: opts.sourceFile ?? null,
        source_page_images: sourcePageImages,
        embedding: await embedPassage(
          passageTextForChunk({
            content_type: c.content_type,
            subject: opts.subject,
            topic: chunkTopic(c, opts),
            content: c.content,
            isTeacherMaterial: Boolean(opts.materialId),
          }),
        ),
      });
    }

    const { error } = await supabase.from("content_chunks").insert(rows);
    if (error) {
      console.error(`Insert failed for batch ${i + 1}/${batches.length}:`, error.message);
      console.error("If this is a permission error, verify RLS policies on content_chunks — an anon key or a table with RLS enabled and zero policies will fail silently or reject writes.");
      throw error;
    }
    chunkCount += rows.length;
    console.log(`Inserted ${rows.length} chunks (batch ${i + 1}/${batches.length}, total ${chunkCount})`);
  }

  console.log("Done.");
  return { chunkCount };
}

/** Appended to a question kept by --questions-only. The tutor is strictly
 * grounded and repeats any answer it finds in a chunk, so a question with no
 * answer must say so in its own text: the tutor then works it through with the
 * student instead of reading silence as permission to state one. Stored but not
 * embedded — the same line on hundreds of rows would pull them together. */
export const QUESTIONS_ONLY_NOTE =
  "(Tiada skema jawapan dalam sumber ini. No answer scheme in the source: work the question through with the student, and do not present any answer as the official one.)";

/** Drops "Jawapan: ..." / "Answer: ..." declaration lines, and everything
 * after the first one: a model that invents an answer often follows it with
 * working. A question's own "Explain your answer" wording has no colon after
 * the word and is left alone. */
export function stripAnswerLines(content: string): string {
  const m = content.match(/^[ \t]*(?:Jawapan|Answer|Penyelesaian|Solution)\s*:.*$/im);
  return m ? content.slice(0, m.index).trimEnd() : content;
}

function storedContent(c: RawChunk, questionsOnly?: boolean): string {
  return questionsOnly && c.content_type === "past_year_question" && c.answer_status === "not_in_source"
    ? `${c.content}\n\n${QUESTIONS_ONLY_NOTE}`
    : c.content;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const rangeLabel = args.startPage || args.endPage
    ? ` (pages ${args.startPage ?? 1}-${args.endPage ?? "end"})`
    : "";
  console.log(`Extracting text from ${args.file}${rangeLabel}${args.vision ? " (vision OCR)" : ""}...`);
  const visionCacheDir = path.join(
    ".cache",
    "vision-ocr",
    path.basename(args.file, path.extname(args.file)).replace(/[^a-zA-Z0-9]+/g, "-"),
  );
  const pages = args.vision
    ? await extractPagesVision(args.file, visionCacheDir, args.startPage, args.endPage)
    : await extractPages(args.file, args.startPage, args.endPage);
  // Only meaningful for the vision path — the plain text-layer path never
  // renders a page image, so there is nothing for a chunk to point at.
  const pageImages = args.vision ? await pageImagePathsFor(visionCacheDir, args.startPage, args.endPage) : [];
  console.log(`Extracted ${pages.length} pages. Batching into groups of ${PAGES_PER_BATCH}...`);

  if (args.dryRun) {
    const batches = batchPages(pages, PAGES_PER_BATCH);
    const allChunks: RawChunk[] = [];
    for (let i = 0; i < batches.length; i++) {
      console.log(`Chunking batch ${i + 1}/${batches.length}...`);
      const chunks = await chunkBatch(batches[i], undefined, undefined, args.questionsOnly);
      allChunks.push(...chunks);
    }
    const droppedCount = allChunks.filter(
      (c) => c.content_type === "past_year_question" && c.answer_status === "not_in_source"
    ).length;
    console.log(
      args.questionsOnly
        ? `Produced ${allChunks.length} chunks (${droppedCount} unanswered questions, kept and marked).`
        : `Produced ${allChunks.length} chunks (${droppedCount} would be dropped for lacking an in-source answer).`,
    );

    const enriched = allChunks.map((c) => ({
      exam_board: args.examBoard,
      subject: args.subject,
      topic: args.topic,
      ...c,
      source: c.source_note,
    }));

    const base = path.basename(args.file, path.extname(args.file));
    const topicSlug = args.topic.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
    const reviewPath = `${base}_${topicSlug}_chunks_review.json`;
    await writeFile(reviewPath, JSON.stringify(enriched, null, 2), "utf-8");
    console.log(`Dry run complete. Review chunks before a real run: ${reviewPath}`);
    return;
  }

  console.log("Embedding and inserting chunks...");
  const topicOptions = args.topicsFromDb ? await existingTopicsFor(args.subject) : undefined;
  if (topicOptions) console.log(`Per-chunk topics enabled, ${topicOptions.length} options: ${topicOptions.join(", ")}`);

  await runIngestion({
    pages,
    examBoard: args.examBoard,
    subject: args.subject,
    topic: args.topic,
    sourceFile: path.basename(args.file),
    topicOptions,
    pageImages,
    firstPageNumber: args.startPage,
    questionsOnly: args.questionsOnly,
  });
}

// Guarded so importing extractPagesFromBuffer/runIngestion from src/lib/materials.ts
// (the teacher upload path) doesn't also trigger a CLI run on import.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
