/**
 * Rebuilds a pilot index after an extraction change, re-embedding only chunks
 * whose text changed and reusing the stored vector for every identical chunk
 * (same doc, page and text), so the experiment varies only the extraction.
 * Book matter is dropped as in the base index.
 *
 *   npx tsx src/rag/reembed-changed.ts <base> <name> [--docs pilot-docs.txt]
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { embedPassage } from "../lib/embeddings.js";
import { bookMatterPages } from "./book-matter.js";
import { pdfPages, readDocList } from "./docs.js";
import { indexDir, loadIndex, saveIndex, type IndexedChunk } from "./pilot-index.js";
import { splitPage } from "./split.js";

const [base, name] = process.argv.slice(2).filter((a, i, all) => !a.startsWith("--") && !all[i - 1]?.startsWith("--docs"));
const docsArg = process.argv.includes("--docs") ? process.argv[process.argv.indexOf("--docs") + 1] : "pilot-docs.txt";
if (!base || !name) throw new Error("usage: reembed-changed <base> <name>");

const old = loadIndex(base);
const raw = readFileSync(path.join(indexDir(base), "vectors.f32"));
const oldVec = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
const dim = oldVec.length / old.chunks.length;
const reuse = new Map(old.chunks.map((c) => [`${c.docId}\u0000${c.page}\u0000${c.text}`, c.id]));

const chunks: IndexedChunk[] = [];
for (const doc of readDocList(docsArg)) {
  const pages = pdfPages(doc.file);
  const drop = bookMatterPages(pages);
  pages.forEach((text, i) => {
    if (drop.has(i + 1)) return;
    for (const part of splitPage(text)) chunks.push({ id: chunks.length, docId: doc.docId, page: i + 1, subject: doc.subject, language: doc.language, text: part });
  });
}
const vectors = new Float32Array(chunks.length * dim);
let embedded = 0;
for (const c of chunks) {
  const hit = reuse.get(`${c.docId}\u0000${c.page}\u0000${c.text}`);
  if (hit !== undefined) vectors.set(oldVec.subarray(hit * dim, (hit + 1) * dim), c.id * dim);
  else {
    vectors.set(await embedPassage(c.text), c.id * dim);
    embedded++;
  }
}
saveIndex(name, chunks, vectors, { ...old.meta, derivedFrom: base, extraction: "pdftotext on glyph-repaired copies where present (.cache/repaired)", reembedded: embedded });
console.log(`index "${name}": ${chunks.length} chunks, ${embedded} re-embedded, ${chunks.length - embedded} reused`);
process.exit(0);
