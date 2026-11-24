/**
 * A file-backed vector index for pilot experiments (rag-stack Phases 2-3), so
 * the pilot never touches the live Supabase knowledge base. A few thousand
 * 768-d vectors fit in memory, and brute-force cosine over them is exact and
 * takes milliseconds — no ANN index needed at this size.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface IndexedChunk {
  id: number;
  docId: string;
  page: number;
  subject: string;
  language: "en" | "ms";
  text: string;
}

export function indexDir(name: string): string {
  return path.resolve(".cache/pilot", name);
}

export function saveIndex(name: string, chunks: IndexedChunk[], vectors: Float32Array, meta: Record<string, unknown>): void {
  const dir = indexDir(name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "chunks.jsonl"), chunks.map((c) => JSON.stringify(c)).join("\n") + "\n");
  writeFileSync(path.join(dir, "vectors.f32"), Buffer.from(vectors.buffer, vectors.byteOffset, vectors.byteLength));
  writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ ...meta, chunks: chunks.length, builtAt: new Date().toISOString() }, null, 2));
}

export function loadIndex(name: string) {
  const dir = indexDir(name);
  if (!existsSync(path.join(dir, "chunks.jsonl"))) throw new Error(`no pilot index "${name}" — build it with src/rag/pilot-ingest.ts`);
  const chunks = readFileSync(path.join(dir, "chunks.jsonl"), "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as IndexedChunk);
  const buf = readFileSync(path.join(dir, "vectors.f32"));
  const vectors = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  const dim = vectors.length / chunks.length;
  const meta = JSON.parse(readFileSync(path.join(dir, "meta.json"), "utf-8"));
  return {
    chunks,
    meta,
    /** Top-k by cosine (vectors are L2-normalised, so cosine = dot product). */
    search(query: number[], k: number): { chunk: IndexedChunk; score: number }[] {
      const scores = new Float32Array(chunks.length);
      for (let i = 0; i < chunks.length; i++) {
        let s = 0;
        const o = i * dim;
        for (let d = 0; d < dim; d++) s += vectors[o + d] * query[d];
        scores[i] = s;
      }
      return [...scores.keys()].sort((a, b) => scores[b] - scores[a]).slice(0, k).map((i) => ({ chunk: chunks[i], score: scores[i] }));
    },
  };
}
