/**
 * Validates a golden-set JSONL before upload (rag-stack Phase 1 gate).
 *
 *   npx tsx src/scripts/golden-check.ts golden/<file>.jsonl [--draft] [--poc]
 *
 * Errors (exit 1): bad schema, TODO text, duplicate questions, a doc_id that is
 * not a file under ~/Desktop/knowledge bases or a teacher upload, an answerable
 * item with no source, an unreviewed item (unless --draft). Warnings: the type
 * and language mix, subjects with few items, a missing test split above 80.
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const TYPES = ["factual", "explanation", "multi_hop", "comparison", "vague", "worked_problem", "past_year", "past_year_request", "teacher_material", "unanswerable"];
const LANGS = ["en", "ms"];
const REVIEW = ["pending", "approved", "fixed", "rejected"];

const [file] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const draft = process.argv.includes("--draft");
const minItems = process.argv.includes("--poc") ? 30 : 50;
if (!file) throw new Error("usage: golden-check <file.jsonl> [--draft] [--poc]");

const kbRoot = path.join(process.env.HOME ?? "", "Desktop/knowledge bases");
const docIds = new Set(
  execSync(`find "${kbRoot}" -iname "*.pdf"`).toString().trim().split("\n").map((f) => path.basename(f).replace(/\.pdf$/i, "").trim()),
);

const errors: string[] = [];
const warnings: string[] = [];
const items = readFileSync(file, "utf-8").split("\n").filter((l) => l.trim()).map((line, i) => {
  try {
    return { n: i + 1, item: JSON.parse(line) };
  } catch {
    errors.push(`line ${i + 1}: not valid JSON`);
    return null;
  }
}).filter(Boolean) as { n: number; item: any }[];

const seen = new Map<string, number>();
for (const { n, item } of items) {
  const q = item?.input?.question;
  const out = item?.expectedOutput;
  const m = item?.metadata ?? {};
  if (m.review === "rejected") continue;
  if (typeof q !== "string" || q.trim().length < 3) errors.push(`line ${n}: input.question missing`);
  if (!out || typeof out.answer !== "string" || !out.answer.trim()) errors.push(`line ${n}: expectedOutput.answer missing`);
  if (typeof out?.answerable !== "boolean") errors.push(`line ${n}: expectedOutput.answerable must be true/false`);
  if (/\bTODO\b/i.test(JSON.stringify(item))) errors.push(`line ${n}: contains TODO`);
  if (!TYPES.includes(m.type)) errors.push(`line ${n}: metadata.type "${m.type}" not one of ${TYPES.join("/")}`);
  if (!LANGS.includes(m.language)) errors.push(`line ${n}: metadata.language "${m.language}" not en/ms`);
  if (!REVIEW.includes(m.review)) errors.push(`line ${n}: metadata.review "${m.review}" not one of ${REVIEW.join("/")}`);
  if (!draft && m.review === "pending") errors.push(`line ${n}: not reviewed yet`);
  if (out?.answerable) {
    const sources = Array.isArray(out.sources) ? out.sources : [];
    if (sources.length === 0 && !m.reasoning_only) errors.push(`line ${n}: answerable but no sources (set metadata.reasoning_only for pure-reasoning items)`);
    for (const s of sources) {
      if (!s.doc_id) errors.push(`line ${n}: source without doc_id`);
      else if (!docIds.has(String(s.doc_id).trim()) && !s.material) errors.push(`line ${n}: doc_id "${s.doc_id}" is not a file in ${kbRoot}`);
    }
  }
  const key = String(q ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  if (seen.has(key)) errors.push(`line ${n}: duplicate of line ${seen.get(key)}`);
  else seen.set(key, n);
}

const live = items.filter(({ item }) => item?.metadata?.review !== "rejected");
const count = (k: string) => {
  const c = new Map<string, number>();
  for (const { item } of live) c.set(item?.metadata?.[k] ?? "?", (c.get(item?.metadata?.[k] ?? "?") ?? 0) + 1);
  return Object.fromEntries([...c].sort((a, b) => b[1] - a[1]));
};
if (live.length < minItems) (draft ? warnings : errors).push(`${live.length} items, gate needs ≥ ${minItems}`);
const unans = live.filter(({ item }) => item?.expectedOutput?.answerable === false).length;
if (unans / Math.max(live.length, 1) < 0.1) warnings.push(`only ${unans} unanswerable items (< 10%)`);
const bySubject = count("subject");
for (const [s, c] of Object.entries(bySubject)) if (c < 5 && s !== "—" && s !== "?") warnings.push(`subject ${s}: only ${c} items`);
if (live.length > 80 && !live.some(({ item }) => item?.metadata?.split === "test")) warnings.push("over 80 items but no split: test");

console.log(`${file}: ${live.length} live items (${items.length - live.length} rejected)`);
console.log("  type:", count("type"));
console.log("  language:", count("language"));
console.log("  subject:", bySubject);
console.log("  origin:", count("origin"), "| review:", count("review"));
for (const w of warnings) console.log("  warn:", w);
for (const e of errors) console.log("  ERROR:", e);
console.log(errors.length ? `\n${errors.length} error(s)` : "\nclean");
process.exitCode = errors.length ? 1 : 0;
