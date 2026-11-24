import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { openai } from "../lib/openai.js";

const execFileAsync = promisify(execFile);
const OCR_MODEL = "gpt-4.1";
const RENDER_DPI = 150;
const CONCURRENCY = 5;

const TRANSCRIBE_SYSTEM = `You transcribe a page image from a Malaysian school textbook into clean plain text for a knowledge base.
Rules:
- Transcribe all body text faithfully, preserving heading/subheading hierarchy as plain lines (no markdown symbols).
- Skip running headers/footers, page numbers, and publisher branding.
- For any photo, map, diagram, or illustration, insert a bracketed description of what it shows and how it relates to the surrounding text, in enough detail to stand in for the image (e.g. "[Map showing the trade routes of the Malacca Sultanate across the Straits of Malacca and the South China Sea]").
- For tables, transcribe them as plain text rows, preserving which values line up with which labels.
- MARKINGS THAT CARRY MEANING MUST SURVIVE. Answer schemes routinely indicate the correct option purely
  by appearance — a highlighted line, a circled or ticked letter, bold or coloured text, an underline, an
  arrow, a handwritten annotation. Plain text extraction loses all of that, which is the whole reason this
  page is being read visually. So whenever a marking singles something out, say so inline in words:
  "C. Siantan  [HIGHLIGHTED — marked as the correct answer]", "B  [circled]", "[ticked]". Never silently
  transcribe a marked option as if it were unmarked. If several options are marked, record each. If you
  cannot tell whether something is marked, transcribe it plainly rather than guessing.
- If the page is blank, a section divider with no real content, or purely decorative, return an empty string.
Return ONLY the transcribed text, no commentary, no JSON, no markdown fences.`;

async function renderPages(pdfPath: string, outDir: string): Promise<string[]> {
  await mkdir(outDir, { recursive: true });
  const existing = await readdir(outDir).catch(() => []);
  if (existing.filter((f) => f.endsWith(".png")).length === 0) {
    await execFileAsync("pdftoppm", ["-png", "-r", String(RENDER_DPI), pdfPath, path.join(outDir, "p")]);
  }
  const files = (await readdir(outDir)).filter((f) => f.endsWith(".png")).sort();
  return files.map((f) => path.join(outDir, f));
}

async function transcribePageOnce(imagePath: string): Promise<string> {
  const b64 = (await readFile(imagePath)).toString("base64");
  const completion = await openai.chat.completions.create({
    model: OCR_MODEL,
    temperature: 0,
    max_tokens: 4096,
    messages: [
      { role: "system", content: TRANSCRIBE_SYSTEM },
      {
        role: "user",
        content: [
          { type: "text", text: "Transcribe this page." },
          { type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } },
        ],
      },
    ],
  });
  return completion.choices[0].message.content ?? "";
}

async function transcribePage(imagePath: string): Promise<string> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await transcribePageOnce(imagePath);
    } catch (err) {
      console.warn(`  OCR failed for ${imagePath} (attempt ${attempt}/3): ${(err as Error).message}`);
      if (attempt === 3) {
        console.warn(`  Giving up on ${imagePath} — treating as blank page.`);
        return "";
      }
    }
  }
  return "";
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

/** Renders each page of `pdfPath` to an image and transcribes it via vision OCR — for
 * scanned/garbled-text-layer PDFs where pdf-parse extraction is unusable. Caches the FULL
 * document's OCR results to `cacheDir` (checkpointed, resumable), keyed only by source PDF —
 * not by chapter — so multiple ingest.ts runs against different page ranges of the same file
 * only pay the OCR cost once. */
export async function extractPagesVision(
  pdfPath: string,
  cacheDir: string,
  startPage?: number,
  endPage?: number,
): Promise<string[]> {
  const resultsFile = path.join(cacheDir, "results.json");
  const cached = await readFile(resultsFile, "utf-8").catch(() => null);
  let allPages: string[];
  if (cached) {
    console.log(`Using cached OCR results: ${resultsFile}`);
    allPages = JSON.parse(cached);
  } else {
    const imageDir = path.join(cacheDir, "pages");
    console.log(`Rendering pages for ${path.basename(pdfPath)}...`);
    const images = await renderPages(pdfPath, imageDir);
    console.log(`Rendered ${images.length} pages. OCR'ing with concurrency ${CONCURRENCY}...`);

    const checkpointFile = `${resultsFile}.partial`;
    const results: (string | undefined)[] = new Array(images.length);
    const cachedPartial = await readFile(checkpointFile, "utf-8").catch(() => null);
    if (cachedPartial) {
      const partial: (string | null)[] = JSON.parse(cachedPartial);
      for (let i = 0; i < partial.length; i++) if (partial[i] !== null && partial[i] !== undefined) results[i] = partial[i] as string;
      console.log(`Resuming from checkpoint: ${results.filter((r) => r !== undefined).length}/${images.length} pages already OCR'd.`);
    }

    let done = results.filter((r) => r !== undefined).length;
    await runPool(images, CONCURRENCY, async (imagePath, i) => {
      if (results[i] !== undefined) return;
      results[i] = await transcribePage(imagePath);
      done++;
      if (done % 10 === 0 || done === images.length) {
        console.log(`  OCR'd ${done}/${images.length}`);
        await writeFile(checkpointFile, JSON.stringify(results, null, 2), "utf-8").catch(() => {});
      }
    });

    await writeFile(resultsFile, JSON.stringify(results, null, 2), "utf-8");
    await rm(checkpointFile, { force: true }).catch(() => {});
    console.log(`Saved OCR results: ${resultsFile}`);
    allPages = results as string[];
  }

  if (startPage === undefined && endPage === undefined) return allPages;
  const from = (startPage ?? 1) - 1;
  const to = endPage ?? allPages.length;
  return allPages.slice(from, to);
}

/** The local rendered page images for a document already processed by
 * extractPagesVision, sliced the same way — a separate call rather than
 * folded into extractPagesVision's own return, so the (unchanged) text
 * return type doesn't ripple through every existing caller. Used to give
 * runIngestion the images to match chunks against and upload — see
 * matchingPageIndices() in ingest.ts. Degrades to an empty array (never
 * throws) when the pages were never rendered, e.g. a cached-text run whose
 * image directory was cleaned up separately from its results.json. */
export async function pageImagePathsFor(cacheDir: string, startPage?: number, endPage?: number): Promise<string[]> {
  const imageDir = path.join(cacheDir, "pages");
  const files = (await readdir(imageDir).catch(() => [] as string[])).filter((f) => f.endsWith(".png")).sort();
  const all = files.map((f) => path.join(imageDir, f));
  if (startPage === undefined && endPage === undefined) return all;
  const from = (startPage ?? 1) - 1;
  const to = endPage ?? all.length;
  return all.slice(from, to);
}
