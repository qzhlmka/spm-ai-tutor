/**
 * Concatenates pilot-format indexes into one (Phase 4: rebuilt textbooks +
 * carried-over live rows). Vectors are copied as stored.
 *
 *   npx tsx src/rag/merge-index.ts <name> <part> <part> ...
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { indexDir, loadIndex, saveIndex } from "./pilot-index.js";

const [name, ...parts] = process.argv.slice(2);
if (!name || parts.length < 2) throw new Error("usage: merge-index <name> <part> <part> ...");
const loaded = parts.map((p) => {
  const ix = loadIndex(p);
  const raw = readFileSync(path.join(indexDir(p), "vectors.f32"));
  return { p, ix, vec: new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4) };
});
const total = loaded.reduce((a, l) => a + l.ix.chunks.length, 0);
const dim = loaded[0].vec.length / loaded[0].ix.chunks.length;
const vectors = new Float32Array(total * dim);
const chunks = [];
for (const { ix, vec } of loaded) {
  vectors.set(vec, chunks.length * dim);
  for (const c of ix.chunks) chunks.push({ ...c, id: chunks.length });
}
saveIndex(name, chunks, vectors, { mergedFrom: Object.fromEntries(loaded.map((l) => [l.p, l.ix.chunks.length])) });
console.log(`index "${name}": ${chunks.length} chunks (${loaded.map((l) => `${l.p} ${l.ix.chunks.length}`).join(" + ")})`);
process.exit(0);
