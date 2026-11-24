/**
 * Pre-embedding check (rag-stack Phase 2). No API calls.
 *
 *   npx tsx src/rag/ingest-check.ts [pilot-docs.txt]
 *
 * Per document: pages with no text (need OCR), pages whose text looks garbled
 * (bad font encoding), and duplicate pages. Writes reports/ingest-check-<date>.md
 * with the counts and 10 sample chunks to read by eye.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { pdfPages, readDocList } from "./docs.js";
import { splitPage } from "./split.js";

const list = process.argv[2] ?? "pilot-docs.txt";
const docs = readDocList(list);

/** Share of letters in words with no vowel at all — high when a font's encoding is broken. */
function garbleScore(text: string): number {
  const words = text.match(/[A-Za-z]{4,}/g) ?? [];
  if (words.length < 20) return 0;
  const bad = words.filter((w) => !/[aeiouyAEIOUY]/.test(w)).length;
  return bad / words.length;
}

const lines: string[] = [`# ingest:check — ${new Date().toISOString().slice(0, 10)} — ${list}`, ""];
lines.push("| doc | pages | NO TEXT | GARBLED | DUPLICATE | chunks |", "|---|---|---|---|---|---|");
const samples: string[] = [];
let problems = 0;
for (const doc of docs) {
  const pages = pdfPages(doc.file);
  const noText: number[] = [];
  const garbled: number[] = [];
  const dup: number[] = [];
  const seen = new Map<string, number>();
  let chunks = 0;
  pages.forEach((t, i) => {
    const p = i + 1;
    const clean = t.replace(/\s+/g, " ").trim();
    if (clean.length < 40) {
      noText.push(p);
      return;
    }
    if (garbleScore(clean) > 0.25) garbled.push(p);
    const h = createHash("md5").update(clean).digest("hex");
    if (seen.has(h)) dup.push(p);
    else seen.set(h, p);
    const parts = splitPage(t);
    chunks += parts.length;
    if (samples.length < 10 && p > pages.length * 0.3 && p % 37 === 0 && parts.length) samples.push(`### ${doc.docId} p${p}\n\n\`\`\`\n${parts[0]}\n\`\`\``);
  });
  // A few blank pages (covers, section dividers) are normal; flag when it is more than that.
  const flag = noText.length > pages.length * 0.1 || garbled.length > 0 || dup.length > 2;
  if (flag) problems++;
  const show = (a: number[]) => (a.length ? `${a.length} (${a.slice(0, 8).join(", ")}${a.length > 8 ? ", …" : ""})` : "0");
  lines.push(`| ${doc.docId} | ${pages.length} | ${show(noText)} | ${show(garbled)} | ${show(dup)} | ${chunks} |`);
}
lines.push("", "## Sample chunks", "", ...samples);
mkdirSync("reports", { recursive: true });
const out = `reports/ingest-check-${new Date().toISOString().slice(0, 10)}.md`;
writeFileSync(out, lines.join("\n") + "\n");
console.log(lines.slice(0, docs.length + 4).join("\n"));
console.log(`\n${problems ? `${problems} document(s) need attention` : "clean"} — full report in ${out}`);
