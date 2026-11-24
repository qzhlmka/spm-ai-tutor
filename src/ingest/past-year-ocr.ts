import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { openai } from "../lib/openai.js";

const execFileAsync = promisify(execFile);

// Vision OCR is used instead of pdf-parse for this source set: the questions PDF
// uses a subset font with no Unicode CMap (text extracts as garbage glyphs), and
// the marking-scheme PDFs render their answer tables as content pdf-parse can't
// pull text from at all (~57 chars/page average). The page images themselves are
// clean, so a vision model reading rendered pages is the only reliable path here.
const OCR_MODEL = "gpt-4.1";
const RENDER_DPI = 150;
const CONCURRENCY = 5;

export interface ChapterHeader {
  form: 4 | 5;
  bab_number: number;
  topic_my: string;
  topic_en: string;
}

export interface BukuQuestion {
  source_exam: string;
  year: number;
  soalan_no: string;
  kertas: "1" | "2" | null;
  marks: number | null;
  question_text: string;
}

export interface SkemaEntry {
  source_exam: string;
  year: number;
  soalan_no: string;
  marking_scheme_text: string;
  total_marks: number | null;
}

export interface BukuPageResult {
  page: number;
  chapter_header: ChapterHeader | null;
  questions: BukuQuestion[];
}

export interface SkemaPageResult {
  page: number;
  chapter_header: Omit<ChapterHeader, "form"> | null;
  entries: SkemaEntry[];
}

const BUKU_SYSTEM = `You transcribe a page image from a Malaysian Add Maths past-year-question compilation book ("Buku Selekoh").
Return strict JSON only, no markdown fences:
{
  "chapter_header": null | { "form": 4 | 5, "bab_number": number, "topic_my": string, "topic_en": string },
  "questions": [
    {
      "source_exam": string,
      "year": number,
      "soalan_no": string,
      "kertas": "1" | "2" | null,
      "marks": number | null,
      "question_text": string
    }
  ]
}
Rules:
- chapter_header: fill only if a chapter banner (e.g. "Bab 2: Fungsi Kuadratik / Chapter 2: Quadratic Functions") appears on this page, else null.
- source_exam: the exam label from the question's header line (e.g. "SPM Bahagian A", "Trial Terengganu", "Trial SBP"), with the year stripped out into the year field.
- soalan_no: the question number from that header line (this is the ORIGINAL exam's question number, not the book's own running numbering).
- question_text: FULL faithful transcription, both Malay and English versions if shown, math notation as plain text (e.g. f(x) = 2x^2 + hx - 2k + 5), diagrams described in words, including any "Ans:" line if present.
- If the page has no questions (checklist, table of contents, blank), return an empty questions array.`;

const SKEMA_SYSTEM = `You transcribe a page image from a Malaysian Add Maths marking-scheme ("Skema Jawapan") book — tables of No | Butiran (working) | Markah (marks).
Return strict JSON only, no markdown fences:
{
  "chapter_header": null | { "bab_number": number, "topic_my": string, "topic_en": string },
  "entries": [
    {
      "source_exam": string,
      "year": number,
      "soalan_no": string,
      "marking_scheme_text": string,
      "total_marks": number | null
    }
  ]
}
Rules:
- chapter_header: fill only if a chapter banner appears on this page, else null.
- source_exam: the exam label (e.g. "Percubaan Negeri Melaka", "SPM Bahagian A"), with the year stripped into the year field.
- soalan_no: the ORIGINAL exam question number from the header line.
- marking_scheme_text: faithful transcription of every working step and its mark code, preserving (a)/(b)/(c) part structure, e.g. "(a) m = -4 [1]\\n|-4+2n| = 0 [1]\\nn = 2 [1]".
- If a page is blank or has no entries, return an empty entries array.`;

async function renderPages(pdfPath: string, outDir: string): Promise<string[]> {
  await mkdir(outDir, { recursive: true });
  const existing = await readdir(outDir).catch(() => []);
  if (existing.filter((f) => f.endsWith(".png")).length === 0) {
    await execFileAsync("pdftoppm", ["-png", "-r", String(RENDER_DPI), pdfPath, path.join(outDir, "p")]);
  }
  const files = (await readdir(outDir)).filter((f) => f.endsWith(".png")).sort();
  return files.map((f) => path.join(outDir, f));
}

async function ocrPageOnce(imagePath: string, system: string): Promise<any> {
  const b64 = (await readFile(imagePath)).toString("base64");
  const completion = await openai.chat.completions.create({
    model: OCR_MODEL,
    temperature: 0,
    max_tokens: 4096,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      {
        role: "user",
        content: [
          { type: "text", text: "Transcribe this page." },
          { type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } },
        ],
      },
    ],
  });
  return JSON.parse(completion.choices[0].message.content ?? "{}");
}

// A single dense page can produce a truncated/malformed JSON response. Retry a
// couple of times; if it still fails, don't take down the whole 579-page run for
// one page — log it and fall back to an empty result (reviewable in the OCR
// results file, and re-run separately if needed).
async function ocrPage(imagePath: string, system: string): Promise<any> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await ocrPageOnce(imagePath, system);
    } catch (err) {
      console.warn(`  OCR parse failed for ${imagePath} (attempt ${attempt}/3): ${(err as Error).message}`);
      if (attempt === 3) {
        console.warn(`  Giving up on ${imagePath} — treating as empty page.`);
        return {};
      }
    }
  }
}

async function runPool<T, R>(items: T[], size: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return results;
}

async function ocrDocument<T>(
  pdfPath: string,
  cacheDir: string,
  system: string,
  resultsFile: string,
  maxPages?: number,
): Promise<T[]> {
  const existing = await readFile(resultsFile, "utf-8").catch(() => null);
  if (existing) {
    console.log(`Using cached OCR results: ${resultsFile}`);
    return JSON.parse(existing);
  }

  const imageDir = path.join(cacheDir, "pages");
  console.log(`Rendering pages for ${path.basename(pdfPath)}...`);
  let images = await renderPages(pdfPath, imageDir);
  if (maxPages) images = images.slice(0, maxPages);
  console.log(`Rendered ${images.length} pages. OCR'ing with concurrency ${CONCURRENCY}...`);

  // Checkpoint the whole results array periodically — a crash partway through a
  // 150-229 page document (a truncated response, a network blip) shouldn't waste
  // everything OCR'd so far. Resuming re-reads this file and only re-OCRs gaps.
  const checkpointFile = `${resultsFile}.partial`;
  const results: T[] = new Array(images.length);
  const cachedPartial = await readFile(checkpointFile, "utf-8").catch(() => null);
  if (cachedPartial) {
    const partial: (T | null)[] = JSON.parse(cachedPartial);
    for (let i = 0; i < partial.length; i++) if (partial[i]) results[i] = partial[i] as T;
    const doneCount = results.filter(Boolean).length;
    console.log(`Resuming from checkpoint: ${doneCount}/${images.length} pages already OCR'd.`);
  }

  let done = results.filter(Boolean).length;
  await runPool(images, CONCURRENCY, async (imagePath, i) => {
    if (results[i]) return;
    const raw = await ocrPage(imagePath, system);
    results[i] = { page: i + 1, ...raw } as T;
    done++;
    if (done % 10 === 0 || done === images.length) {
      console.log(`  OCR'd ${done}/${images.length}`);
      await writeFile(checkpointFile, JSON.stringify(results, null, 2), "utf-8").catch(() => {});
    }
  });

  await writeFile(resultsFile, JSON.stringify(results, null, 2), "utf-8");
  await rm(checkpointFile, { force: true }).catch(() => {});
  console.log(`Saved OCR results: ${resultsFile}`);
  return results;
}

export async function ocrBukuSelekoh(pdfPath: string, cacheDir: string, maxPages?: number): Promise<BukuPageResult[]> {
  return ocrDocument<BukuPageResult>(pdfPath, cacheDir, BUKU_SYSTEM, path.join(cacheDir, "results.json"), maxPages);
}

export async function ocrSkema(pdfPath: string, cacheDir: string, maxPages?: number): Promise<SkemaPageResult[]> {
  return ocrDocument<SkemaPageResult>(pdfPath, cacheDir, SKEMA_SYSTEM, path.join(cacheDir, "results.json"), maxPages);
}
