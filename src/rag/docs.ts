/**
 * Source documents for the rebuilt pipeline (rag-stack Phase 2+). A document's
 * `doc_id` is its filename without `.pdf` — the same id the golden set's
 * sources use — and page numbers are physical PDF pages, 1-based.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const KB_ROOT = path.join(process.env.HOME ?? "", "Desktop/knowledge bases");

export interface SourceDoc {
  file: string; // relative to KB_ROOT
  docId: string;
  subject: string;
  language: "en" | "ms";
}

const SUBJECT_BY_FOLDER: Record<string, string> = {
  physics: "Physics",
  mathematics: "Mathematics",
  "additional mathematics": "Add Maths",
  sejarah: "Sejarah",
  chemistry: "Chemistry",
};

/** Malay unless the filename says English; matches how these files are named. */
function languageOf(file: string): "en" | "ms" {
  return /english|\(eng\)|\bdlp\b|form \d kssm\.pdf$/i.test(file) && !/kimia|sejarah|malay|\(bm\)/i.test(file) ? "en" : "ms";
}

export function readDocList(listFile: string): SourceDoc[] {
  return readFileSync(listFile, "utf-8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((file) => ({
      file,
      docId: path.basename(file).replace(/\.pdf$/i, "").trim(),
      subject: SUBJECT_BY_FOLDER[file.split("/")[0]] ?? "Unknown",
      language: languageOf(file),
    }));
}

/** Copies with math-font glyph names repaired (src/rag/repair_glyphs.py), used
 * in place of the original when present — see p3-glyph-repair in RAG_STATUS.md. */
export const REPAIRED_ROOT = path.resolve(".cache/repaired");

/** Vision-OCR cache written by src/ingest/vision-extract.ts, one results.json per PDF. */
const OCR_CACHE = path.resolve(".cache/vision-ocr");

/** Text of every page. The PDF's own text layer when it is usable; the vision-OCR
 * cache only when more than 30% of pages have no text and a complete cache exists
 * (Sejarah T5 is a scan with no text layer). Preferring the text layer keeps the
 * pilot books extracted exactly as in Phase 3. */
export function pdfPages(file: string, { repaired = true } = {}): string[] {
  const pages = textLayerPages(file, repaired);
  const empty = pages.filter((p) => p.replace(/\s+/g, "").length < 40).length;
  if (empty > pages.length * 0.3) {
    const cache = path.join(OCR_CACHE, path.basename(file, ".pdf").replace(/[^A-Za-z0-9]+/g, "-"), "results.json");
    if (existsSync(cache)) {
      const ocr = (JSON.parse(readFileSync(cache, "utf-8")) as (string | null)[]).map((t) => t ?? "");
      if (ocr.length === pages.length && ocr.every((t) => t.trim())) return ocr;
    }
  }
  return pages;
}

function textLayerPages(file: string, repaired: boolean): string[] {
  const fixed = path.join(REPAIRED_ROOT, file);
  const abs = repaired && existsSync(fixed) ? fixed : path.join(KB_ROOT, file);
  const pages = Number(/Pages:\s+(\d+)/.exec(execFileSync("pdfinfo", [abs]).toString())?.[1] ?? 0);
  const text = execFileSync("pdftotext", ["-layout", "-enc", "UTF-8", abs, "-"], { maxBuffer: 1 << 28 }).toString();
  // The radical sign in DLP Add Maths F4 is two Mathematical Pi-Three glyphs
  // ("!" + "w") outside the font's /Differences, so glyph repair cannot reach it.
  // "!w" occurs 621 times across the 16 textbooks, all of them radicals (2026-10-13).
  const split = text.replace(/!w/g, "√").split("\f");
  return Array.from({ length: pages }, (_, i) => split[i] ?? "");
}
