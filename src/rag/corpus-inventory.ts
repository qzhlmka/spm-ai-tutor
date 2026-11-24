/**
 * Full-corpus inventory for Phase 4 planning. No API calls, no writes to the DB.
 *
 *   npx tsx --env-file=.env src/rag/corpus-inventory.ts
 *
 * Per PDF under KB_ROOT: kind (by path/name), pages, pages with no text, pages
 * whose text looks garbled, whether a vision-OCR cache exists, and how many
 * live content_chunks rows carry its filename. Writes reports/corpus-inventory-<date>.md
 * and .json. Route: "text" when the text layer is usable, "ocr" when more than
 * 30% of pages have no text or look garbled (or a complete OCR cache exists).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { supabase } from "../lib/supabase.js";
import { KB_ROOT } from "./docs.js";

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : /\.pdf$/i.test(f) ? [p] : [];
  });
}
function kindOf(rel: string): string {
  const s = rel.toLowerCase();
  if (/skema|jawapan|answer/.test(s)) return "answer_scheme";
  if (/nota contengan|class note|nota kelas/.test(s)) return "class_notes";
  if (/selekoh|past|percubaan|trial|spm 20|kertas|paper|soalan|modul/.test(s)) return "past_year";
  if (/textbook|buku teks|kssm|dlp|tingkatan/.test(s)) return "textbook";
  return "other";
}
function garbled(text: string): boolean {
  const words = text.match(/[A-Za-z]{4,}/g) ?? [];
  return words.length >= 20 && words.filter((w) => !/[aeiouyAEIOUY]/.test(w)).length / words.length > 0.25;
}

// Live rows per source_file (paginated: PostgREST caps responses at 1000 rows).
const live = new Map<string, number>();
for (let from = 0; ; from += 1000) {
  const { data, error } = await supabase.from("content_chunks").select("source_file").not("source_file", "is", null).order("id").range(from, from + 999);
  if (error) throw error;
  for (const r of data ?? []) live.set(r.source_file, (live.get(r.source_file) ?? 0) + 1);
  if ((data ?? []).length < 1000) break;
}

const rows: { file: string; subject: string; kind: string; pages: number; noText: number; garbled: number; ocrCached: number; route: string; liveChunks: number; mb: number }[] = [];
for (const abs of walk(KB_ROOT).sort()) {
  const rel = path.relative(KB_ROOT, abs);
  let pages = 0, noText = 0, bad = 0;
  try {
    pages = Number(/Pages:\s+(\d+)/.exec(execFileSync("pdfinfo", [abs]).toString())?.[1] ?? 0);
    const split = execFileSync("pdftotext", ["-layout", "-enc", "UTF-8", abs, "-"], { maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "ignore"] }).toString().split("\f");
    for (let i = 0; i < pages; i++) {
      const t = (split[i] ?? "").replace(/\s+/g, " ").trim();
      if (t.length < 40) noText++;
      else if (garbled(t)) bad++;
    }
  } catch { /* unreadable PDF: counted as all no-text */ noText = pages; }
  const slug = path.basename(rel, ".pdf").replace(/[^A-Za-z0-9]+/g, "-");
  const cache = path.resolve(".cache/vision-ocr", slug, "results.json");
  const ocrCached = existsSync(cache) ? (JSON.parse(readFileSync(cache, "utf-8")) as unknown[]).filter(Boolean).length : 0;
  const route = ocrCached >= pages * 0.9 && pages > 0 ? "ocr-cached" : (noText + bad) / Math.max(pages, 1) > 0.3 ? "ocr" : "text";
  rows.push({ file: rel, subject: rel.split("/")[0], kind: kindOf(rel), pages, noText, garbled: bad, ocrCached, route, liveChunks: live.get(path.basename(rel)) ?? 0, mb: +(statSync(abs).size / 1e6).toFixed(1) });
}

const date = new Date().toISOString().slice(0, 10);
mkdirSync("reports", { recursive: true });
writeFileSync(`reports/corpus-inventory-${date}.json`, JSON.stringify(rows, null, 2));
const sum = (f: (r: (typeof rows)[number]) => boolean, k: "pages" | "liveChunks" = "pages") => rows.filter(f).reduce((a, r) => a + r[k], 0);
const groups = [...new Set(rows.map((r) => `${r.subject} / ${r.kind}`))].sort();
const md = [`# Corpus inventory — ${date}`, "", `${rows.length} PDFs, ${sum(() => true)} pages.`, "",
  "| subject / kind | files | pages | route text | route ocr (new) | route ocr-cached | in live DB (files) |", "|---|---|---|---|---|---|---|",
  ...groups.map((g) => {
    const r = rows.filter((x) => `${x.subject} / ${x.kind}` === g);
    const pg = (route: string) => r.filter((x) => x.route === route).reduce((a, x) => a + x.pages, 0);
    return `| ${g} | ${r.length} | ${r.reduce((a, x) => a + x.pages, 0)} | ${pg("text")} | ${pg("ocr")} | ${pg("ocr-cached")} | ${r.filter((x) => x.liveChunks > 0).length} |`;
  }),
  "", "## Files", "", "| file | kind | pages | no text | garbled | OCR cached | route | live chunks |", "|---|---|---|---|---|---|---|---|",
  ...rows.map((r) => `| ${r.file} | ${r.kind} | ${r.pages} | ${r.noText} | ${r.garbled} | ${r.ocrCached} | ${r.route} | ${r.liveChunks} |`)];
writeFileSync(`reports/corpus-inventory-${date}.md`, md.join("\n") + "\n");
console.log(md.slice(0, 6 + groups.length + 2).join("\n"));
console.log(`\nroute totals (pages): text ${sum((r) => r.route === "text")}, ocr NEW ${sum((r) => r.route === "ocr")}, ocr-cached ${sum((r) => r.route === "ocr-cached")}`);
process.exit(0);
