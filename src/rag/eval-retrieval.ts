/**
 * Retrieval eval against the golden dataset in Langfuse (rag-stack Phases 2-3).
 * Retrieval only — no answer is generated.
 *
 *   npx tsx --env-file=.env src/rag/eval-retrieval.ts <dataset> <run-name> [--index p2-baseline] [--pilot] [--k 10] [--hybrid]
 *
 * --hybrid fuses a BM25 keyword lane with the vector lane by RRF (hybrid.ts).
 * --rerank N reorders the top N candidates with a local cross-encoder (rerank.ts).
 * --db <lane> searches the kb_chunks table through the kb_search RPC (lane main,
 * teacher, past_year or all) instead of a local index — Phase 4 parity check.
 * --exclude-origin <origin> leaves chunks of that origin out of the ranking (e.g.
 * carried_past_year — past-year questions answered from their own lane, as the
 * live app does).
 * --scope <docs.txt> labels each item "in-list" (every gold doc is in the list,
 * e.g. the rebuilt textbooks) or "other" and reports both. Chunks with page 0
 * (carried-over live rows that never recorded a page) count as a hit on a
 * matching doc_id only — a FILE-level hit — and the item is marked so.
 *
 * A retrieved chunk is a hit when its (doc_id, page) equals one of the item's
 * gold sources. Per item: hit@5, reciprocal rank (within k), precision@5.
 * --pilot keeps only answerable items with a source in pilot-docs.txt.
 * Every run is a Langfuse dataset run, with per-item scores and run averages.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { LangfuseClient } from "@langfuse/client";
import { embedQuery } from "../lib/embeddings.js";
import { supabase } from "../lib/supabase.js";
import { flushTracing } from "../lib/tracing.js";
import { readDocList } from "./docs.js";
import { buildBm25, LANE_DEPTH, rrf } from "./hybrid.js";
import { loadIndex } from "./pilot-index.js";
import { RERANK_MODEL, rerankScores } from "./rerank.js";

const [dataset, runName] = process.argv.slice(2).filter((a, i, all) => !a.startsWith("--") && !all[i - 1]?.startsWith("--"));
const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(k);
  return i >= 0 ? process.argv[i + 1] : d;
};
if (!dataset || !runName) throw new Error("usage: eval-retrieval <dataset> <run-name> [--index name] [--pilot] [--k 10]");
const indexName = arg("--index", "p2-baseline");
const K = Number(arg("--k", "10"));
const pilotOnly = process.argv.includes("--pilot");
const hybrid = process.argv.includes("--hybrid");
const rerankN = Number(arg("--rerank", "0"));
const scopeDocs = process.argv.includes("--scope") ? new Set(readDocList(arg("--scope", "")).map((d) => d.docId)) : null;

const dbLane = arg("--db", "");
const index = dbLane ? { chunks: [] as any[], meta: { source: "kb_chunks", lane: dbLane }, search: () => [] as any[] } : loadIndex(indexName);
const excludeOrigin = arg("--exclude-origin", "");
const allowed = (i: number) => !excludeOrigin || (index.chunks[i] as { origin?: string }).origin !== excludeOrigin;
const bm25 = hybrid ? buildBm25(index.chunks) : null;
const pilotDocs = new Set(readDocList("pilot-docs.txt").map((d) => d.docId));
const langfuse = new LangfuseClient();
const ds = await langfuse.dataset.get(dataset);

type Source = { doc_id: string; page: number };
const goldOf = (item: { expectedOutput?: any }) => ((item.expectedOutput?.sources ?? []) as Source[]);
const items = ds.items.filter((it: any) => {
  if (!it.expectedOutput?.answerable) return false;
  const gold = goldOf(it);
  return pilotOnly ? gold.some((s) => pilotDocs.has(s.doc_id)) : gold.length > 0;
});
console.log(`${dataset}: ${ds.items.length} items, ${items.length} in scope${pilotOnly ? " (pilot)" : ""} — index "${indexName}" (${index.chunks.length} chunks)`);

const isHit = (gold: Source[]) => (c: { docId: string; page: number }) => gold.some((s) => s.doc_id === c.docId && (s.page === c.page || c.page === 0));
const groupOf = (gold: Source[]) => (scopeDocs ? (gold.every((s) => scopeDocs.has(s.doc_id)) ? "in-list" : "other") : "all");

const rows: { question: string; split: string; group: string; fileLevel: boolean; hit5: number; rr: number; p5: number; top: string }[] = [];
const splitOf: Map<string, string> = new Map(items.map((it: any) => [it.input.question, it.metadata?.split ?? "dev"]));
const result = await langfuse.experiment.run({
  name: "retrieval",
  runName,
  description: `retrieval only, index ${indexName}, k=${K}${hybrid ? ", hybrid BM25+vector RRF" : ""}${rerankN ? `, rerank top ${rerankN}` : ""}`,
  metadata: { index: indexName, k: K, pilot: pilotOnly, hybrid, excludeOrigin: excludeOrigin || null, rerank: rerankN ? { model: RERANK_MODEL, top: rerankN } : null, ...index.meta },
  data: items,
  maxConcurrency: 1,
  task: async ({ input }: any) => {
    if (dbLane) {
      const emb = await embedQuery(input.question);
      const { data, error } = await supabase.rpc("kb_search", { query_embedding: `[${emb.join(",")}]`, query_text: input.question, lane: dbLane, match_count: K });
      if (error) throw error;
      return (data ?? []).map((r: any) => ({ doc_id: r.doc_id, page: r.page, score: Number(Number(r.rrf_score).toFixed(4)), preview: r.content.slice(0, 120) }));
    }
    const depth = Math.max(K, rerankN);
    const vector = index.search(await embedQuery(input.question), (bm25 ? LANE_DEPTH : depth) * (excludeOrigin ? 4 : 1)).filter((h) => allowed(h.chunk.id)).slice(0, bm25 ? LANE_DEPTH : depth);
    let hits = bm25
      ? rrf([vector.map((h) => h.chunk.id), bm25(input.question, LANE_DEPTH * 4).map((h) => h.index).filter(allowed).slice(0, LANE_DEPTH)], depth).map((f) => ({ chunk: index.chunks[f.index], score: f.score }))
      : vector;
    if (rerankN) {
      const pool = hits.slice(0, rerankN);
      const scores = await rerankScores(input.question, pool.map((h) => h.chunk.text));
      hits = pool.map((h, i) => ({ chunk: h.chunk, score: scores[i] })).sort((a, b) => b.score - a.score);
    }
    hits = hits.slice(0, K);
    return hits.map((h) => ({ doc_id: h.chunk.docId, page: h.chunk.page, score: Number(h.score.toFixed(4)), preview: h.chunk.text.slice(0, 120) }));
  },
  evaluators: [
    async ({ input, output, expectedOutput }: any) => {
      const hit = isHit(expectedOutput.sources ?? []);
      const ranked = (output as { doc_id: string; page: number }[]).map((o) => ({ docId: o.doc_id, page: o.page }));
      const first = ranked.findIndex(hit);
      const fileLevel = first >= 0 && ranked[first].page === 0;
      const hit5 = first >= 0 && first < 5 ? 1 : 0;
      const rr = first >= 0 ? 1 / (first + 1) : 0;
      const p5 = ranked.slice(0, 5).filter(hit).length / 5;
      rows.push({ question: input.question, split: splitOf.get(input.question) ?? "dev", group: groupOf(expectedOutput.sources ?? []), fileLevel, hit5, rr, p5, top: `${ranked[0]?.docId} p${ranked[0]?.page}` });
      return [
        { name: "recall_at_5", value: hit5 },
        { name: "reciprocal_rank", value: rr },
        { name: "precision_at_5", value: p5 },
      ];
    },
  ],
  runEvaluators: [
    async ({ itemResults }: any) => {
      const mean = (name: string) => {
        const v = itemResults.flatMap((r: any) => r.evaluations.filter((e: any) => e.name === name).map((e: any) => e.value as number));
        return v.length ? v.reduce((a: number, b: number) => a + b, 0) / v.length : 0;
      };
      return [
        { name: "recall_at_5", value: mean("recall_at_5") },
        { name: "mrr", value: mean("reciprocal_rank") },
        { name: "precision_at_5", value: mean("precision_at_5") },
      ];
    },
  ],
});

const avg = (k: "hit5" | "rr" | "p5", split?: string) => {
  const r = split ? rows.filter((x) => x.split === split) : rows;
  return r.reduce((a, x) => a + x[k], 0) / Math.max(r.length, 1);
};
const line = (split?: string) => `Recall@5 ${avg("hit5", split).toFixed(3)}   MRR ${avg("rr", split).toFixed(3)}   P@5 ${avg("p5", split).toFixed(3)}   (n=${split ? rows.filter((x) => x.split === split).length : rows.length})`;
console.log(`\n${runName}:  ${line()}`);
if (rows.some((r) => r.split === "test")) console.log(`  dev:  ${line("dev")}\n  test: ${line("test")}`);
if (scopeDocs) {
  for (const g of ["in-list", "other"]) {
    const r = rows.filter((x) => x.group === g);
    const m = (k: "hit5" | "rr") => (r.reduce((a, x) => a + x[k], 0) / Math.max(r.length, 1)).toFixed(3);
    console.log(`  ${g.padEnd(7)}: Recall@5 ${m("hit5")}   MRR ${m("rr")}   (n=${r.length}, file-level hits ${r.filter((x) => x.fileLevel).length})`);
  }
}
console.log("\nmisses (gold not in top 5):");
for (const r of rows.filter((r) => !r.hit5)) console.log(`  rr=${r.rr.toFixed(2)} [${r.split}${scopeDocs ? `/${r.group}` : ""}] ${r.question.slice(0, 80)}  → top: ${r.top}`);
mkdirSync("reports", { recursive: true });
writeFileSync(`reports/${runName}.json`, JSON.stringify({ runName, dataset, index: indexName, k: K, pilot: pilotOnly, recall_at_5: avg("hit5"), mrr: avg("rr"), precision_at_5: avg("p5"), dev: { recall_at_5: avg("hit5", "dev"), mrr: avg("rr", "dev") }, test: { recall_at_5: avg("hit5", "test"), mrr: avg("rr", "test") }, rows }, null, 2));
console.log(`\nLangfuse dataset run: ${result.runName ?? runName}`);
await flushTracing();
process.exit(0);
