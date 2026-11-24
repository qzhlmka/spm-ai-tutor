/**
 * Keyword (BM25) lane and rank fusion for the pilot index (rag-stack Phase 3,
 * experiment p3-hybrid).
 *
 * Why: dense vectors blur exact terms. The baseline misses were questions
 * whose answer page is identified by literal notation or a fixed phrase —
 * "(A ∩ B)'", "nth term of a geometric progression" — which e5 ranks below
 * pages that are merely about the same chapter. BM25 scores the exact words.
 *
 * Tokens are letters/digits runs plus set-notation symbols, lowercased after
 * NFKC. No stemming: the corpus is English and Malay, and an English stemmer
 * mangles Malay words. Fusion is reciprocal rank fusion (RRF), which needs no
 * score calibration between the two lanes — BM25 and cosine are on unrelated
 * scales.
 */
import type { IndexedChunk } from "./pilot-index.js";

const K1 = 1.2;
const B = 0.75;
export const RRF_K = 60;
export const LANE_DEPTH = 50;

export function tokenize(text: string): string[] {
  return text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+|[∩∪⊂⊆∈∉']/gu) ?? [];
}

export function buildBm25(chunks: IndexedChunk[]) {
  const docs = chunks.map((c) => {
    const tf = new Map<string, number>();
    const toks = tokenize(c.text);
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
    return { tf, len: toks.length };
  });
  const df = new Map<string, number>();
  for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const n = docs.length;
  const avgLen = docs.reduce((a, d) => a + d.len, 0) / n;
  const idf = (t: string) => Math.log(1 + (n - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));

  return function search(query: string, k: number): { index: number; score: number }[] {
    const terms = [...new Set(tokenize(query))];
    const scores: { index: number; score: number }[] = [];
    docs.forEach((d, i) => {
      let s = 0;
      for (const t of terms) {
        const f = d.tf.get(t);
        if (f) s += idf(t) * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * d.len) / avgLen)));
      }
      if (s > 0) scores.push({ index: i, score: s });
    });
    return scores.sort((a, b) => b.score - a.score).slice(0, k);
  };
}

/** Reciprocal rank fusion of several ranked lists of chunk indices. */
export function rrf(lanes: number[][], k: number): { index: number; score: number }[] {
  const score = new Map<number, number>();
  for (const lane of lanes) lane.forEach((idx, rank) => score.set(idx, (score.get(idx) ?? 0) + 1 / (RRF_K + rank + 1)));
  return [...score].map(([index, s]) => ({ index, score: s })).sort((a, b) => b.score - a.score).slice(0, k);
}
