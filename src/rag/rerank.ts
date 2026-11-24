/**
 * Cross-encoder reranking for the pilot (rag-stack Phase 3, experiment
 * p3-rerank). Runs locally like the embeddings — no API cost.
 *
 * Why: after hybrid retrieval every remaining miss had its gold page at ranks
 * 7-10, behind near-identical pages from the same chapter (the sets chapter has
 * ~30 pages full of ∩/∪). A bi-encoder embeds question and page separately; a
 * cross-encoder reads them together and scores how well this page answers this
 * question, which is the distinction those misses need.
 *
 * Model: bge-reranker-v2-m3 (multilingual, so Malay questions are scored
 * against Malay pages as well as English ones), ONNX, quantised.
 */
import { AutoModelForSequenceClassification, AutoTokenizer } from "@huggingface/transformers";

export const RERANK_MODEL = "onnx-community/bge-reranker-v2-m3-ONNX";
const MAX_TOKENS = 512;
const BATCH = 8;

let loaded: Promise<[any, any]> | null = null;
function load() {
  loaded ??= Promise.all([
    AutoTokenizer.from_pretrained(RERANK_MODEL),
    AutoModelForSequenceClassification.from_pretrained(RERANK_MODEL, { dtype: "q8" }),
  ]);
  return loaded;
}

/** Relevance logit per passage for this query, in input order. */
export async function rerankScores(query: string, passages: string[]): Promise<number[]> {
  const [tokenizer, model] = await load();
  const out: number[] = [];
  for (let i = 0; i < passages.length; i += BATCH) {
    const batch = passages.slice(i, i + BATCH);
    const inputs = tokenizer(new Array(batch.length).fill(query), { text_pair: batch, padding: true, truncation: true, max_length: MAX_TOKENS });
    const { logits } = await model(inputs);
    out.push(...(Array.from(logits.data as Float32Array) as number[]));
  }
  return out;
}
