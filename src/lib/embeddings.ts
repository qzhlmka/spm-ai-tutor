import { pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";

// Embeddings run locally in this process via multilingual-e5-base (768 dims,
// Transformers.js/onnxruntime-node) instead of OpenAI's embeddings API — no
// per-token cost. Chosen over gte-base because the knowledge base can
// contain multilingual source documents (e.g. Malay-language textbook
// material), which multilingual-e5-base is explicitly trained for and
// gte-base is not.
//
// This runs in-process rather than as a Supabase Edge Function: Node has
// full onnxruntime-node support with no Edge Function-style memory/
// filesystem sandbox, and both call sites (ingestion in src/ingest/ingest.ts,
// query-time embedding in src/routes/chat.ts) are already plain Node
// processes, so there's no serverless constraint to design around.
const MODEL_NAME = "Xenova/multilingual-e5-base";

let extractorPromise: Promise<FeatureExtractionPipeline> | null = null;
function getExtractor() {
  extractorPromise ??= pipeline("feature-extraction", MODEL_NAME, { dtype: "q8" });
  return extractorPromise;
}

// E5 models are trained on asymmetrically-prefixed pairs — a search query and
// the passage it should match are NOT embedded the same way. Per the model
// card: skipping this prefix causes real performance degradation, not just a
// stylistic nicety. So there is no bare `embed()` — every caller must say
// whether it's embedding a student's question (embedQuery) or a knowledge
// base chunk (embedPassage), and the wrong choice will silently work but
// retrieve worse.
async function embedWithPrefix(prefix: "query" | "passage", text: string): Promise<number[]> {
  const extractor = await getExtractor();
  const output = await extractor(`${prefix}: ${text}`, { pooling: "mean", normalize: true });
  return Array.from(output.data as Float32Array);
}

export function embedQuery(text: string): Promise<number[]> {
  return embedWithPrefix("query", text);
}

export function embedPassage(text: string): Promise<number[]> {
  return embedWithPrefix("passage", text);
}
