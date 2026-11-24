/**
 * Drafts golden-set items from the RAW source documents (Phase 1 of the
 * rag-stack process) — not from the index, so the set does not depend on how
 * anything was chunked or embedded.
 *
 * For each entry in PLAN it samples content pages from a PDF (seeded, so a
 * re-run picks the same pages), reads their text (the vision-OCR cache when the
 * file was OCR'd, else the PDF's text layer), and asks Claude to write
 * student-style questions answerable from those pages alone, with a short
 * reference answer and the physical page numbers used. Every item is written
 * with `review: "pending"`: nothing here is trusted until a teacher checks it.
 *
 *   npx tsx --env-file=.env src/scripts/golden-draft.ts [--dry-run] [--plan pilot-v4]
 *
 * Writes golden/tutor-golden-v1.drafted.jsonl, or with --plan pilot-v4
 * golden/tutor-golden-v4.pilot-drafted.jsonl (more items from the 7 pilot
 * books, so one Phase 3 item is worth ~0.02 instead of 0.042).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type Anthropic from "@anthropic-ai/sdk";
import { TUTOR_MODEL } from "../lib/anthropic.js";
import { tracedMessage, flushTracing } from "../lib/tracing.js";
import { bookMatterPages } from "../rag/book-matter.js";

const KB_ROOT = path.join(process.env.HOME ?? "", "Desktop/knowledge bases");
const OCR_CACHE = path.resolve(".cache/vision-ocr");
const PLAN_NAME = process.argv.includes("--plan") ? process.argv[process.argv.indexOf("--plan") + 1] : "v1";
const OUT = path.resolve(PLAN_NAME === "pilot-v4" ? "golden/tutor-golden-v4.pilot-drafted.jsonl" : "golden/tutor-golden-v1.drafted.jsonl");
const MIN_PAGE_CHARS = 900;

type ItemType = "factual" | "explanation" | "multi_hop" | "comparison" | "vague" | "worked_problem" | "past_year";
type Lang = "en" | "ms";

interface PlanEntry {
  file: string; // relative to KB_ROOT
  subject: string;
  language: Lang;
  /** Single pages to sample, each yielding one item. */
  singles: { type: ItemType; count: number }[];
  /** Pairs of nearby pages, each yielding one item that needs both. */
  pairs?: { type: "multi_hop" | "comparison"; count: number }[];
}

// Fills the gaps the 28 real questions leave (golden/real-question-candidates.md):
// no Sejarah, little Mathematics/Physics, no comparison or multi-hop items.
const PLAN: PlanEntry[] = [
  { file: "sejarah/Buku Teks Sejarah T4.pdf", subject: "Sejarah", language: "ms", singles: [{ type: "factual", count: 2 }, { type: "explanation", count: 1 }], pairs: [{ type: "comparison", count: 1 }] },
  { file: "sejarah/Buku Teks Sejarah T5.pdf", subject: "Sejarah", language: "ms", singles: [{ type: "factual", count: 2 }, { type: "vague", count: 1 }], pairs: [{ type: "multi_hop", count: 1 }] },
  { file: "sejarah/SEJARAH SKEMA SELEKOH 2024 F5 - Rozi Ogy.pdf", subject: "Sejarah", language: "ms", singles: [{ type: "past_year", count: 2 }] },
  { file: "mathematics/Textbook Maths Form 4 (Eng).pdf", subject: "Mathematics", language: "en", singles: [{ type: "factual", count: 1 }, { type: "worked_problem", count: 1 }], pairs: [{ type: "comparison", count: 1 }] },
  { file: "mathematics/Textbook Maths Form 5 (Eng).pdf", subject: "Mathematics", language: "en", singles: [{ type: "explanation", count: 1 }, { type: "worked_problem", count: 1 }], pairs: [{ type: "multi_hop", count: 1 }] },
  { file: "mathematics/Textbook Maths Form 4 (BM).pdf", subject: "Mathematics", language: "ms", singles: [{ type: "vague", count: 1 }, { type: "factual", count: 1 }] },
  { file: "physics/Textbook Physics Form 4 (English).pdf", subject: "Physics", language: "en", singles: [{ type: "factual", count: 1 }, { type: "explanation", count: 1 }], pairs: [{ type: "comparison", count: 1 }] },
  { file: "physics/Textbook Physics Form 5 (English).pdf", subject: "Physics", language: "en", singles: [{ type: "worked_problem", count: 1 }, { type: "explanation", count: 1 }] },
  { file: "physics/Textbook Physics Form 5 (Malay).pdf", subject: "Physics", language: "ms", singles: [{ type: "factual", count: 1 }, { type: "vague", count: 1 }] },
  { file: "additional mathematics/DLP Additional Mathematics Form 4.pdf", subject: "Add Maths", language: "en", singles: [{ type: "worked_problem", count: 2 }, { type: "factual", count: 1 }] },
  { file: "additional mathematics/MT DLP KSSM T5_6233333650692243837.pdf", subject: "Add Maths", language: "en", singles: [{ type: "explanation", count: 1 }, { type: "worked_problem", count: 1 }], pairs: [{ type: "multi_hop", count: 1 }] },
  { file: "chemistry/Chemistry Form 5 KSSM.pdf", subject: "Chemistry", language: "en", singles: [{ type: "explanation", count: 1 }], pairs: [{ type: "comparison", count: 1 }] },
  { file: "chemistry/Kimia Tingkatan 5 KSSM.pdf", subject: "Chemistry", language: "ms", singles: [{ type: "factual", count: 1 }] },
  {
    file: "chemistry/NOTA CONTENGAN KELAS/ALPHA/FORM 5/BAB 2 _ SEBATIAN KARBON/23 DEC - GC CHE - SEBATIAN KARBON (Carbon Compound) .pdf",
    subject: "Chemistry",
    language: "ms",
    singles: [{ type: "explanation", count: 1 }],
  },
];

// Phase 3 (2026-10-13): 26 more items from the 7 pilot books. Mostly single-page
// types — the retrieval gate is about finding the page — with Malay where the
// book is Malay. Pages already used as a gold source in golden-v3 are excluded.
const PILOT_V4: PlanEntry[] = [
  { file: "physics/Textbook Physics Form 4 (English).pdf", subject: "Physics", language: "en", singles: [{ type: "factual", count: 1 }, { type: "explanation", count: 1 }, { type: "vague", count: 1 }, { type: "worked_problem", count: 1 }] },
  { file: "physics/Textbook Physics Form 5 (English).pdf", subject: "Physics", language: "en", singles: [{ type: "factual", count: 1 }, { type: "explanation", count: 1 }, { type: "vague", count: 1 }, { type: "worked_problem", count: 1 }] },
  { file: "physics/Textbook Physics Form 5 (Malay).pdf", subject: "Physics", language: "ms", singles: [{ type: "factual", count: 1 }, { type: "explanation", count: 1 }, { type: "vague", count: 1 }, { type: "worked_problem", count: 1 }] },
  { file: "mathematics/Textbook Maths Form 4 (Eng).pdf", subject: "Mathematics", language: "en", singles: [{ type: "factual", count: 1 }, { type: "explanation", count: 1 }, { type: "vague", count: 1 }, { type: "worked_problem", count: 1 }] },
  { file: "additional mathematics/DLP Additional Mathematics Form 4.pdf", subject: "Add Maths", language: "en", singles: [{ type: "factual", count: 1 }, { type: "explanation", count: 1 }, { type: "vague", count: 1 }, { type: "worked_problem", count: 1 }] },
  { file: "sejarah/Buku Teks Sejarah T4.pdf", subject: "Sejarah", language: "ms", singles: [{ type: "factual", count: 1 }, { type: "explanation", count: 1 }, { type: "vague", count: 1 }] },
  { file: "chemistry/Chemistry Form 5 KSSM.pdf", subject: "Chemistry", language: "en", singles: [{ type: "factual", count: 1 }, { type: "explanation", count: 1 }, { type: "vague", count: 1 }] },
];

function usedGoldPages(): Set<string> {
  const f = path.resolve("golden/tutor-golden-v3.jsonl");
  if (!existsSync(f)) return new Set();
  return new Set(
    readFileSync(f, "utf-8").split("\n").filter(Boolean)
      .flatMap((l) => (JSON.parse(l).expectedOutput.sources ?? []).map((s: { doc_id: string; page: number }) => `${s.doc_id}#${s.page}`)),
  );
}

const TYPE_GUIDE: Record<ItemType, string> = {
  factual: "one specific fact, definition, date, formula or value stated on the page",
  explanation: "a how/why question whose answer needs a short explanation from the page",
  multi_hop: "a question that can only be answered by combining information from BOTH pages",
  comparison: "a question comparing two things (concepts, events, methods) that the pages describe",
  vague: "a loosely worded question a confused student would type, using different words from the page",
  worked_problem: "a calculation with the student's OWN numbers (different from any example on the page) solved by the page's method; the answer shows the steps",
  past_year: "the past-year exam question on the page, asked the way a student would ask for help with it; the answer is the marked/official answer shown on the page",
};

const ITEM_TOOL: Anthropic.Tool = {
  name: "propose_items",
  description: "Propose golden-set items drafted from the given pages. Return an empty list if the pages are unsuitable.",
  input_schema: {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            question: { type: "string", description: "What the student types. Paraphrased — never copies the page's sentences." },
            answer: { type: "string", description: "Short reference answer (2-6 sentences, or the worked steps), using ONLY facts on the pages." },
            pages: { type: "array", items: { type: "integer" }, description: "Physical PDF page numbers the answer comes from." },
            difficulty: { type: "string", enum: ["easy", "medium", "hard"] },
          },
          required: ["question", "answer", "pages", "difficulty"],
        },
      },
      skipped_reason: { type: "string", description: "Why no item was produced, when the list is empty." },
    },
    required: ["items"],
  },
};

const SYSTEM = `You write evaluation items for an SPM (Malaysian KSSM, Form 4-5) tutoring app. The app may only
teach from its documents, so each item tests whether it finds and uses the right page.

Rules:
- Write exactly the number of items asked, of the type asked, in the language asked (en = English, ms = Bahasa Melayu).
- The question sounds like a real Form 4/5 student typing in a chat box. Paraphrase; never copy a sentence from the page.
- The answer uses ONLY what is on the pages given. If the pages do not support a good item (index, contents,
  exercises with no answers, a page that is mostly a diagram you cannot read), return no items and say why.
- Never write a question whose answer depends on a picture the page text does not describe.
- List the page numbers you actually used.`;

function seededRandom(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

function slugFor(file: string): string {
  return path.basename(file, ".pdf").replace(/[^A-Za-z0-9]+/g, "-");
}

/** Text of every page of a PDF under KB_ROOT, from the vision-OCR cache when it was OCR'd. */
export function pageTexts(file: string): string[] {
  const abs = path.join(KB_ROOT, file);
  const cached = path.join(OCR_CACHE, slugFor(file), "results.json");
  if (existsSync(cached)) return (JSON.parse(readFileSync(cached, "utf-8")) as (string | null)[]).map((t) => t ?? "");
  const pages = Number(/Pages:\s+(\d+)/.exec(execFileSync("pdfinfo", [abs]).toString())?.[1] ?? 0);
  const all = execFileSync("pdftotext", ["-layout", "-f", "1", "-l", String(pages), abs, "-"], { maxBuffer: 1 << 28 }).toString();
  return all.split("\f").slice(0, pages);
}

async function draft(entry: PlanEntry, type: ItemType, pages: number[], texts: string[]) {
  const body = pages.map((p) => `=== PAGE ${p} ===\n${texts[p - 1].slice(0, 6000)}`).join("\n\n");
  const message = await tracedMessage("golden-draft", {
    model: TUTOR_MODEL,
    max_tokens: 1500,
    thinking: { type: "disabled" as const },
    system: SYSTEM,
    tools: [ITEM_TOOL],
    tool_choice: { type: "tool", name: ITEM_TOOL.name },
    messages: [
      {
        role: "user",
        content: `Subject: ${entry.subject}\nLanguage: ${entry.language}\nType: ${type} — ${TYPE_GUIDE[type]}\nNumber of items: 1\n\n${body}`,
      },
    ],
  });
  const tool = message.content.find((b) => b.type === "tool_use");
  const input = (tool?.input ?? {}) as { items?: { question: string; answer: string; pages: number[]; difficulty: string }[]; skipped_reason?: string };
  return { items: input.items ?? [], skipped: input.skipped_reason };
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  mkdirSync(path.dirname(OUT), { recursive: true });
  const out: string[] = [];
  const pilot = PLAN_NAME === "pilot-v4";
  let seed = pilot ? 20261013 : 20261009;
  const used = pilot ? usedGoldPages() : new Set<string>();
  for (const entry of pilot ? PILOT_V4 : PLAN) {
    const texts = pageTexts(entry.file);
    const n = texts.length;
    const docId = path.basename(entry.file, ".pdf").trim();
    // Skip front and back matter; keep pages with real text. The pilot plan uses
    // the content-based detector (the Physics F4 PDF is page-scrambled) and
    // skips pages already used as gold.
    const matter = pilot ? bookMatterPages(texts) : new Set<number>();
    const usable = texts.map((t, i) => i + 1).filter((p) =>
      (pilot ? !matter.has(p) && !used.has(`${docId}#${p}`) : p > n * 0.08 && p < n * 0.95) && texts[p - 1].trim().length >= MIN_PAGE_CHARS);
    const rand = seededRandom(seed++);
    const pick = () => usable.splice(Math.floor(rand() * usable.length), 1)[0];
    const jobs: { type: ItemType; pages: number[] }[] = [];
    for (const s of entry.singles) for (let i = 0; i < s.count; i++) jobs.push({ type: s.type, pages: [pick()] });
    for (const pr of entry.pairs ?? [])
      for (let i = 0; i < pr.count; i++) {
        const a = pick();
        const b = usable.filter((p) => p !== a && Math.abs(p - a) <= 2).sort((x, y) => Math.abs(x - a) - Math.abs(y - a))[0] ?? a + 1;
        jobs.push({ type: pr.type, pages: [a, b].sort((x, y) => x - y) });
      }
    console.log(`${entry.file} — ${n} pages, ${usable.length} usable — ${jobs.map((j) => `${j.type}@${j.pages.join("+")}`).join(", ")}`);
    if (dryRun) continue;
    for (const job of jobs) {
      const { items, skipped } = await draft(entry, job.type, job.pages, texts);
      if (items.length === 0) console.log(`   skipped ${job.type}@${job.pages.join("+")}: ${skipped ?? "no reason given"}`);
      for (const it of items) {
        out.push(
          JSON.stringify({
            input: { question: it.question },
            expectedOutput: {
              answer: it.answer,
              sources: it.pages.map((page) => ({ doc_id: path.basename(entry.file, ".pdf"), page })),
              answerable: true,
            },
            metadata: {
              ...(pilot ? { drafted_from_pages: job.pages } : {}),
              type: job.type,
              difficulty: it.difficulty,
              language: entry.language,
              subject: entry.subject,
              split: "dev",
              origin: "drafted",
              review: "pending",
            },
          }),
        );
        console.log(`   + [${job.type}] ${it.question}`);
      }
    }
  }
  if (!dryRun) {
    writeFileSync(OUT, out.join("\n") + "\n");
    console.log(`\nwrote ${out.length} items to ${path.relative(process.cwd(), OUT)}`);
  }
  await flushTracing();
}

// Only when run directly — golden-real.ts imports pageTexts from here.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
