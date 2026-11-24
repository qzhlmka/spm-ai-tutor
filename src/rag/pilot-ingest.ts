/**
 * Builds the pilot index (rag-stack Phase 2): text layer -> baseline splitter
 * -> local multilingual-e5-base passage embeddings -> .cache/pilot/<name>/.
 * No API calls and no database writes.
 *
 *   npx tsx src/rag/pilot-ingest.ts [--name p2-baseline] [--docs pilot-docs.txt]
 */
import { embedPassage } from "../lib/embeddings.js";
import { pdfPages, readDocList } from "./docs.js";
import { saveIndex, type IndexedChunk } from "./pilot-index.js";
import { CHUNK_OVERLAP, CHUNK_SIZE, splitPage } from "./split.js";

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(k);
  return i >= 0 ? process.argv[i + 1] : d;
};
const name = arg("--name", "p2-baseline");
const list = arg("--docs", "pilot-docs.txt");

const docs = readDocList(list);
const chunks: IndexedChunk[] = [];
for (const doc of docs) {
  pdfPages(doc.file).forEach((text, i) => {
    for (const part of splitPage(text)) chunks.push({ id: chunks.length, docId: doc.docId, page: i + 1, subject: doc.subject, language: doc.language, text: part });
  });
}
console.log(`${docs.length} docs, ${chunks.length} chunks — embedding locally…`);

const DIM = 768;
const vectors = new Float32Array(chunks.length * DIM);
const t0 = Date.now();
for (const c of chunks) {
  vectors.set(await embedPassage(c.text), c.id * DIM);
  if ((c.id + 1) % 250 === 0) {
    const rate = (c.id + 1) / ((Date.now() - t0) / 1000);
    process.stdout.write(`\r  ${c.id + 1}/${chunks.length}  (${rate.toFixed(1)}/s, ~${Math.round((chunks.length - c.id) / rate / 60)} min left)`);
  }
}
saveIndex(name, chunks, vectors, { docs: list, splitter: `recursive ${CHUNK_SIZE}/${CHUNK_OVERLAP} per page`, embedding: "multilingual-e5-base q8, passage: prefix" });
console.log(`\nsaved index "${name}" (${chunks.length} chunks) in ${Math.round((Date.now() - t0) / 1000)}s`);
process.exit(0);
