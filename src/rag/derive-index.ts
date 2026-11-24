/**
 * Derives a pilot index from an existing one by dropping chunks, reusing the
 * stored vectors, so an experiment that only REMOVES content changes exactly one
 * variable and costs no re-embedding (rag-stack Phase 3).
 *
 *   npx tsx src/rag/derive-index.ts <base> <name> --drop-book-matter [--docs pilot-docs.txt]
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { bookMatterPages } from "./book-matter.js";
import { pdfPages, readDocList } from "./docs.js";
import { indexDir, loadIndex, saveIndex } from "./pilot-index.js";

const [base, name] = process.argv.slice(2).filter((a, i, all) => !a.startsWith("--") && !all[i - 1]?.startsWith("--docs"));
const docsArg = process.argv.includes("--docs") ? process.argv[process.argv.indexOf("--docs") + 1] : "pilot-docs.txt";
if (!base || !name || !process.argv.includes("--drop-book-matter")) throw new Error("usage: derive-index <base> <name> --drop-book-matter");

const index = loadIndex(base);
const drop = new Map<string, Set<number>>();
for (const d of readDocList(docsArg)) drop.set(d.docId, bookMatterPages(pdfPages(d.file)));

const raw = readFileSync(path.join(indexDir(base), "vectors.f32"));
const all = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
const dim = all.length / index.chunks.length;
const kept = index.chunks.filter((c) => !drop.get(c.docId)?.has(c.page));
const vectors = new Float32Array(kept.length * dim);
const chunks = kept.map((c, i) => {
  vectors.set(all.subarray(c.id * dim, (c.id + 1) * dim), i * dim);
  return { ...c, id: i };
});
const pages = [...drop.values()].reduce((a, s) => a + s.size, 0);
saveIndex(name, chunks, vectors, { ...index.meta, derivedFrom: base, dropped: `book matter (front/back), ${pages} pages, ${index.chunks.length - kept.length} chunks` });
console.log(`index "${name}": ${kept.length}/${index.chunks.length} chunks kept, ${pages} book-matter pages dropped`);
for (const [doc, s] of drop) if (s.size) console.log(`  ${doc}: ${s.size} pages`);

// Guard: a dropped page that is a golden source would make this experiment cheat in reverse.
const gold = readFileSync("golden/tutor-golden-v3.jsonl", "utf-8").split("\n").filter(Boolean).flatMap((l) => JSON.parse(l).expectedOutput.sources ?? []);
const hit = gold.filter((s: { doc_id: string; page: number }) => drop.get(s.doc_id)?.has(s.page));
console.log(hit.length ? `WARNING: ${hit.length} golden source page(s) dropped: ${JSON.stringify(hit)}` : "no golden source page is dropped");
process.exit(0);
