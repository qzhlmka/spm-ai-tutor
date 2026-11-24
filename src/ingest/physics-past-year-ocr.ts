import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { openai } from "../lib/openai.js";

const execFileAsync = promisify(execFile);

// Unlike Add Maths, these Physics PDFs extract as clean plain text — vision OCR
// is used anyway because past-year MCQs constantly reference diagrams ("Rajah 16
// shows...") that plain text extraction can't see at all. A vision model reading
// the rendered page picks up what the diagram actually shows.
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
  question_no: number;
  source_exam: string | null;
  question_text: string;
}

export interface SkemaEntry {
  question_no: number;
  answer: "A" | "B" | "C" | "D" | null;
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

export interface QuizQuestion {
  question_no: number;
  topic_guess: string;
  question_text: string;
}

export interface QuizPageResult {
  page: number;
  questions: QuizQuestion[];
}

const KNOWN_TOPICS_HINT =
  "Measurement, Force and Motion I, Gravitation, Heat, Waves, Light and Optics, Force and Motion II, " +
  "Pressure, Electricity, Electromagnetism, Electronics, Nuclear Physics, Quantum Physics";

const BUKU_SYSTEM = `You transcribe a page image from a Malaysian Physics past-year-question compilation book ("Buku Selekoh").
Return strict JSON only, no markdown fences:
{
  "chapter_header": null | { "form": 4 | 5, "bab_number": number, "topic_my": string, "topic_en": string },
  "questions": [
    {
      "question_no": number,
      "source_exam": string | null,
      "question_text": string
    }
  ]
}
Rules:
- chapter_header: ONLY the top-level "BAB N" banner (e.g. "BAB 6 CAHAYA DAN OPTIK / LIGHTS AND OPTICS") —
  topic_my/topic_en must be the chapter's own name (e.g. "Cahaya dan Optik" / "Light and Optics"), never a
  numbered subsection heading like "2.2 Graf Gerakan Linear" (that's a subsection within the chapter, not
  the chapter itself — ignore those and return null for chapter_header on such pages, since the chapter
  carries forward from the last real BAB banner you saw). form is 4 or 5 depending on which section of the
  book this is (Form 4 chapters come first, then Form 5). If no BAB banner is visible on this page, null.
- question_no: the compilation's own running number printed next to the question (resets to 1 at the start of each chapter) — NOT the original exam's own question number.
- source_exam: the citation shown near the question (e.g. "MRSM 2023 (3)", "SBP 2022"), or null if none shown.
- question_text: FULL faithful bilingual (Malay + English) transcription, including all four MCQ options A/B/C/D, and describe any diagram/graph/circuit shown in words in enough detail to answer the question (e.g. "Circuit diagram: a 6V battery connected to two resistors, 4Ω and 8Ω, in series").
- If the page has no questions (chapter divider, blank, table of contents), return an empty questions array.`;

const SKEMA_SYSTEM = `You transcribe a page image from a Malaysian Physics marking-scheme ("Skema Jawapan") — a simple
numbered list of multiple-choice answers (A/B/C/D), organized by chapter.
Return strict JSON only, no markdown fences:
{
  "chapter_header": null | { "bab_number": number, "topic_my": string, "topic_en": string },
  "entries": [
    { "question_no": number, "answer": "A" | "B" | "C" | "D" }
  ]
}
Rules:
- chapter_header: read from the header banner (e.g. "BAB 6: CAHAYA DAN OPTIK / LIGHTS AND OPTIC"); null if not present on this page (carries forward from the previous page).
- entries: every numbered answer shown on this page, in order.
- If the page is blank or has no entries, return an empty entries array.`;

const QUIZ_SYSTEM = `You transcribe a page image from a Malaysian Physics weekly quiz ("Kuiz Mingguan") — a flat set of
multiple-choice questions with NO chapter structure and no answer key in this document.
Return strict JSON only, no markdown fences:
{
  "questions": [
    { "question_no": number, "topic_guess": string, "question_text": string }
  ]
}
Rules:
- question_no: the number printed before the question.
- topic_guess: your best guess at which KSSM Physics topic this question belongs to, choosing the closest
  match from this list: ${KNOWN_TOPICS_HINT}.
- question_text: FULL faithful bilingual transcription including all four MCQ options A/B/C/D, describing
  any diagram/graph/circuit in words.
- If the page has no questions, return an empty questions array.`;

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
): Promise<T[]> {
  const existing = await readFile(resultsFile, "utf-8").catch(() => null);
  if (existing) {
    console.log(`Using cached OCR results: ${resultsFile}`);
    return JSON.parse(existing);
  }

  const imageDir = path.join(cacheDir, "pages");
  console.log(`Rendering pages for ${path.basename(pdfPath)}...`);
  const images = await renderPages(pdfPath, imageDir);
  console.log(`Rendered ${images.length} pages. OCR'ing with concurrency ${CONCURRENCY}...`);

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

export async function ocrBukuSelekoh(pdfPath: string, cacheDir: string): Promise<BukuPageResult[]> {
  return ocrDocument<BukuPageResult>(pdfPath, cacheDir, BUKU_SYSTEM, path.join(cacheDir, "results.json"));
}

export async function ocrSkema(pdfPath: string, cacheDir: string): Promise<SkemaPageResult[]> {
  return ocrDocument<SkemaPageResult>(pdfPath, cacheDir, SKEMA_SYSTEM, path.join(cacheDir, "results.json"));
}

export async function ocrQuiz(pdfPath: string, cacheDir: string): Promise<QuizPageResult[]> {
  return ocrDocument<QuizPageResult>(pdfPath, cacheDir, QUIZ_SYSTEM, path.join(cacheDir, "results.json"));
}
