/**
 * Answer eval (rag-stack Phase 5): runs every golden item through the real tutor
 * answer step with context from kb_search, then an AI judge scores the answer.
 *
 *   npx tsx --env-file=.env src/rag/eval-answers.ts <dataset> <run-name> [--limit N] [--concurrency 3]
 *        [--judge-label production] [--reuse reports/<earlier-run>.json] [--prompt-variant live]
 *        [--retrieval kb|live] [--pipeline full] [--only questions.json]
 *
 * --only takes a JSON array of question strings and runs just those items — a
 * targeted sample before paying for a full run.
 *
 * --pipeline full runs each question through the real chat handler
 * (handleChatRequest) as a STUDENT: router, catalogue, every retrieval lane,
 * exam lane and notes — the only mode that exercises a catalogue turn ("kimia
 * tingkatan 4 ada bab apa"), which skips retrieval entirely. The judge's
 * evidence is the exact prompt the tutor answered from (onPrompt hook). Unlike
 * the other modes this WRITES: one conversation and its messages per item,
 * plus usage rows, on the first teacher account acting as a student.
 *
 * --retrieval live runs the app's CURRENT retrieval (retrieveContext over
 * content_chunks: six lanes, teacher relevance judge, exam lane) instead of
 * kb_search — Run B, the cutover comparison. Its teacher judge records usage
 * against the first teacher account (teachers are exempt from the cap), the
 * one database write this mode makes, as the earlier test harnesses did.
 *
 * --reuse re-grades the answers saved by an earlier run instead of calling the
 * tutor again (judge changes only; retrieval is deterministic, so the judge sees
 * the same material the tutor saw). --judge-label picks the judge prompt version.
 *
 * The tutor prompt is built the way handleChatRequestUntraced builds it — the
 * same TUTOR_SYSTEM_PROMPT, the STUDENT asker line, the reply-language
 * directive, buildContext's chunk labels, and the same "Background knowledge …
 * What the student actually asked" framing — so what is measured is the answer
 * a student would get, with only retrieval swapped. Nothing is written to the
 * database: no conversation, no message, no usage row.
 *
 * Context (12 chunks, like MAX_CONTEXT_CHUNKS): main lane top 10 + past-year
 * lane top 2. Teacher chunks are not labelled as the student's own teacher's
 * material — the live relevance judge that earns that label is not ported yet.
 *
 * Judge: one forced tool call per answer on TUTOR_MODEL, prompt from Langfuse
 * prompt management ("answer-judge", label production). Scores:
 *   faithfulness   share of the answer's factual claims supported by the context (judge v3:
 *                  claim by claim, each "stated" claim's quote checked against the material)
 *   correctness    answerable items: 1 agrees with the reference, 0.5 partial, 0 wrong/refused
 *   refusal        unanswerable items: 1 = declined without inventing, else 0
 *   false_refusal  answerable items: 1 = refused although the context had the answer
 * Targets (Intake Brief): faithfulness 0.90, correctness 0.80, refusal 0.90.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type Anthropic from "@anthropic-ai/sdk";
import { LangfuseClient } from "@langfuse/client";
import { TUTOR_MODEL } from "../lib/anthropic.js";
import { env } from "../lib/env.js";
import { buildContext, handleChatRequest, retrieveContext, type RetrievedChunk } from "../lib/chat-handler.js";
import { parseExamFilterFromQuestion } from "../lib/exam-label.js";
import { PROMPT_VARIANTS } from "./prompt-variants.js";
import { embedQuery } from "../lib/embeddings.js";
import { DEFAULT_PROVIDER, generateTutorAnswer } from "../lib/providers.js";
import { replyLanguageDirective, studentLanguage } from "../lib/reply-language.js";
import { supabase } from "../lib/supabase.js";
import { flushTracing, tracedMessage } from "../lib/tracing.js";

const [dataset, runName] = process.argv.slice(2).filter((a, i, all) => !a.startsWith("--") && !all[i - 1]?.startsWith("--"));
const arg = (k: string, d: string) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
if (!dataset || !runName) throw new Error("usage: eval-answers <dataset> <run-name> [--limit N] [--concurrency 3]");
const LIMIT = Number(arg("--limit", "0"));
const promptVariant = arg("--prompt-variant", "live");
const retrievalMode = arg("--retrieval", "kb");
if (!["kb", "live"].includes(retrievalMode)) throw new Error("--retrieval must be kb or live");
const pipeline = arg("--pipeline", "answer");
if (!["answer", "full"].includes(pipeline)) throw new Error("--pipeline must be answer or full");
const SYSTEM_PROMPT = PROMPT_VARIANTS[promptVariant];
if (!SYSTEM_PROMPT) throw new Error(`unknown --prompt-variant ${promptVariant}`);
const CONCURRENCY = Number(arg("--concurrency", "3"));
const MAIN_K = 10;
const PAST_YEAR_K = 2;

const langfuse = new LangfuseClient();
const judgeLabel = arg("--judge-label", "production");
const judgePrompt = await langfuse.prompt.get("answer-judge", { label: judgeLabel });
const reuseFile = arg("--reuse", "");
const reused: Map<string, { answer: string; tokens: unknown }> = reuseFile
  ? new Map(JSON.parse(readFileSync(reuseFile, "utf-8")).rows.map((r: any) => [r.question, { answer: r.answer, tokens: r.tokens }]))
  : new Map();

type KbRow = { id: number; origin: string; doc_id: string; page: number; subject: string | null; content: string; content_type: string | null; source: string | null; material_id: string | null };

async function retrieve(question: string): Promise<KbRow[]> {
  const emb = `[${(await embedQuery(question)).join(",")}]`;
  const lane = async (lane: string, k: number) => {
    const { data, error } = await supabase.rpc("kb_search", { query_embedding: emb, query_text: question, lane, match_count: k });
    if (error) throw error;
    return (data ?? []) as KbRow[];
  };
  const [main, pastYear] = await Promise.all([lane("main", MAIN_K), lane("past_year", PAST_YEAR_K)]);
  return [...main, ...pastYear];
}

/** kb_chunks rows in the shape buildContext labels: textbook rows get their book and page as the source line. */
function toRetrieved(rows: KbRow[]): RetrievedChunk[] {
  return rows.map((r) => ({
    id: String(r.id),
    content: r.content,
    source: r.origin === "textbook" ? `${r.doc_id}, page ${r.page}` : r.source,
    content_type: r.content_type ?? "textbook page",
    difficulty: null,
    material_id: r.material_id,
    subject: r.subject,
  }) as RetrievedChunk);
}

const JUDGE_TOOL: Anthropic.Tool = {
  name: "grade_answer",
  description: "Grade one tutor answer.",
  input_schema: {
    type: "object",
    properties: {
      refused: { type: "boolean", description: "The answer declines or says the material does not cover the question, instead of answering it." },
      faithfulness: { type: "integer", enum: [0, 1], description: "1 if every factual claim is supported by the retrieved material (reasoning and arithmetic on the student's own numbers is allowed); 0 if any fact, formula, date, definition or answer is not in the material." },
      unsupported_claims: { type: "array", items: { type: "string" }, description: "Each claim not supported by the material, quoted briefly. Empty when faithfulness is 1." },
      correctness: { type: "number", enum: [0, 0.5, 1], description: "Only for answerable items: 1 agrees with the reference answer's core; 0.5 partly right or incomplete; 0 wrong or refused. For unanswerable items give 0." },
      reason: { type: "string", description: "One or two sentences explaining the grades." },
    },
    required: ["refused", "faithfulness", "unsupported_claims", "correctness", "reason"],
  },
};

// answer-judge v3+: claim by claim, each factual claim with a verbatim quote
// from the material, checked in code below. Two judgings of the same answer
// disagreed on ~a dozen items under v1/v2 ("judge noise"); making the judge show
// its evidence is meant to cut that, and is measured by running it twice.
const CLAIMS_TOOL: Anthropic.Tool = {
  name: "grade_answer_claims",
  description: "Grade one tutor answer claim by claim.",
  input_schema: {
    type: "object",
    properties: {
      refused: { type: "boolean", description: "The answer declines the request instead of answering it (see the rubric)." },
      claims: {
        type: "array",
        description: "Every factual claim in the answer (facts, definitions, formulas, dates, values, mechanisms, causes, examples, official answers). Leave out arithmetic, restatements and advice.",
        items: {
          type: "object",
          properties: {
            claim: { type: "string", description: "The claim, briefly." },
            kind: { type: "string", enum: ["stated", "derived", "unsupported"], description: "stated: the material states it — give the quote. derived: follows directly from material or question by arithmetic or one obvious step — say from what. unsupported: neither." },
            evidence: { type: "string", description: "stated: a VERBATIM quote (8-30 words) copied from the retrieved material. derived: what it follows from. unsupported: empty." },
          },
          required: ["claim", "kind", "evidence"],
        },
      },
      correctness: { type: "number", enum: [0, 0.5, 1], description: "Only for answerable items: 1 agrees with the reference answer's core; 0.5 partly right or incomplete; 0 wrong or refused. For unanswerable items give 0." },
      reason: { type: "string", description: "One or two sentences explaining the grades." },
    },
    required: ["refused", "claims", "correctness", "reason"],
  },
};

const norm = (t: string) =>
  t.toLowerCase().normalize("NFKC").replace(/[₀-₉]/g, (d) => String(d.charCodeAt(0) - 0x2080)).replace(/[^\p{L}\p{N}]+/gu, " ").trim();
/**
 * A judge quote counts as found when at least half its word 3-grams occur in the
 * material, or 90% of its words do (equations and tables, whose layout the judge
 * rebuilds differently from the OCR text). Exact matching rejected 225 quotes
 * across two v3 runs, 203 of them sharing >= 50% of their 3-grams with the
 * material (2026-10-13) — subscripts, hyphenation and spacing, not invention.
 */
function quoteInContext(quote: string, context: string): boolean {
  const ctx = norm(context);
  const w = norm(quote).split(" ").filter(Boolean);
  if (!w.length) return false;
  const words = new Set(ctx.split(" "));
  const uni = w.filter((x) => words.has(x)).length / w.length;
  if (w.length < 3) return uni === 1;
  const grams = w.slice(0, -2).map((_, i) => w.slice(i, i + 3).join(" "));
  return grams.filter((g) => ctx.includes(g)).length / grams.length >= 0.5 || uni >= 0.9;
}

/** One judge verdict, retried when the output cannot be read.
 *
 * Until 2026-10-13 an unreadable verdict was scored as 0 faithfulness AND 0
 * correctness: 6-10 of 73 answerable items in every v3 run (A, B, C,
 * lexical-judged, exam-order), several of them good answers that scored 1 in
 * the neighbouring run. That alone moved correctness by up to ~0.14 and is
 * most of the "noise" seen between runs. Now: up to 3 attempts, and an item
 * still unreadable is marked judgeFailed and left out of the means. */
async function judge(question: string, reference: string, answerable: boolean, context: string, answer: string) {
  let last: Awaited<ReturnType<typeof judgeOnce>> | undefined;
  for (let attempt = 1; attempt <= 3; attempt++) {
    last = await judgeOnce(question, reference, answerable, context, answer);
    if (!last.judgeFailed) return last;
    console.warn(`judge output unreadable (attempt ${attempt}, stop_reason ${last.stopReason}): ${question.slice(0, 60)}`);
  }
  return last!;
}

async function judgeOnce(question: string, reference: string, answerable: boolean, context: string, answer: string) {
  const claimsMode = (judgePrompt.config as { tool?: string } | undefined)?.tool === CLAIMS_TOOL.name;
  const tool = claimsMode ? CLAIMS_TOOL : JUDGE_TOOL;
  const msg = await tracedMessage("answer-judge", {
    model: TUTOR_MODEL,
    max_tokens: claimsMode ? 6000 : 800,
    thinking: { type: "disabled" as const },
    system: judgePrompt.prompt as string,
    tools: [tool],
    tool_choice: { type: "tool", name: tool.name },
    messages: [{
      role: "user",
      content: `QUESTION:\n${question}\n\nANSWERABLE FROM THE KNOWLEDGE BASE: ${answerable ? "yes" : "no — the right behaviour is to decline"}\n\nREFERENCE ANSWER:\n${reference}\n\nRETRIEVED MATERIAL (all the tutor was given):\n${context}\n\nTUTOR ANSWER:\n${answer}`,
    }],
  });
  const input = (msg.content.find((c) => c.type === "tool_use")?.input ?? {}) as Record<string, any>;
  if (!claimsMode) return { ...(input as { refused?: boolean; faithfulness?: number; unsupported_claims?: string[]; correctness?: number; reason?: string; claims?: unknown[] }), judgeFailed: input.correctness === undefined, stopReason: msg.stop_reason };
  // Faithfulness is computed here, not taken from the model: a "stated" claim
  // whose quote is not actually in the material is treated as unsupported.
  // The model sometimes emits the array as a JSON string; accept both, and treat
  // an unparseable list as a failed judging rather than a clean pass.
  // Seen on long inputs: the WHOLE tool input nested as a JSON string inside
  // "claims" ({"claims": "{\"claims\": [...], \"refused\": …}"}), so unwrap
  // that object too and take refused / correctness / reason from it.
  let rawClaims: unknown = input.claims ?? [];
  let unreadable = false;
  try {
    if (typeof rawClaims === "string") rawClaims = JSON.parse(rawClaims);
    if (rawClaims && !Array.isArray(rawClaims) && typeof rawClaims === "object") {
      const nested = rawClaims as Record<string, any>;
      for (const k of ["refused", "correctness", "reason"]) if (input[k] === undefined && nested[k] !== undefined) input[k] = nested[k];
      rawClaims = typeof nested.claims === "string" ? JSON.parse(nested.claims) : nested.claims ?? [];
    }
  } catch {
    unreadable = true;
    rawClaims = [];
  }
  const judgeFailed = unreadable || !Array.isArray(rawClaims) || input.correctness === undefined;
  const claims = (Array.isArray(rawClaims) ? rawClaims as { claim: string; kind: string; evidence: string }[] : []).map((c) => ({
    ...c,
    quoteFound: c.kind === "stated" ? quoteInContext(c.evidence ?? "", context) : null,
  }));
  const bad = claims.filter((c) => c.kind === "unsupported" || (c.kind === "stated" && !c.quoteFound));
  // Faithfulness is the SHARE of supported claims (RAGAS-style). All-or-nothing
  // scored 0.60/0.62 on the same answers in two runs — one stray detail fails a
  // 15-claim answer — while the share scored 0.875/0.875 (mean per-answer
  // difference 0.06). faithfulness_all keeps the strict reading for reference.
  return {
    refused: input.refused,
    faithfulness: claims.length ? (claims.length - bad.length) / claims.length : 1,
    faithfulness_all: bad.length === 0 ? 1 : 0,
    unsupported_claims: bad.map((c) => `${c.claim}${c.kind === "stated" ? " [quote not found in material]" : ""}`),
    correctness: input.correctness,
    reason: input.reason,
    claims,
    judgeFailed,
    stopReason: msg.stop_reason,
  };
}

let teacherId = "";
if (retrievalMode === "live" || pipeline === "full") {
  const { data, error } = await supabase.from("users").select("id").eq("role", "teacher").limit(1).single();
  if (error || !data) throw new Error("no teacher account for --retrieval live / --pipeline full");
  teacherId = data.id;
}

/** The context the tutor gets, and a short list of where it came from. */
async function contextFor(question: string): Promise<{ context: string; sources: string[] }> {
  if (retrievalMode === "live") {
    const r = await retrieveContext({ userId: teacherId, question, history: [], examFilter: parseExamFilterFromQuestion(question), pastYearSubjectUnknown: false, log: console });
    if (!r) throw new Error("live retrieval failed");
    return {
      context: buildContext(r.retrieved, r.gatedTeacherChunkIds, r.examChunks),
      sources: r.retrieved.map((c) => `${c.material_id ? "teacher" : c.content_type}:${(c.source ?? "").slice(0, 50)}`),
    };
  }
  const retrieved = await retrieve(question);
  return { context: buildContext(toRetrieved(retrieved), new Set(), []), sources: retrieved.map((r) => `${r.origin}:${r.doc_id}${r.page ? ` p${r.page}` : ""}`) };
}

const ds = await langfuse.dataset.get(dataset);
const onlyFile = arg("--only", "");
const only = onlyFile ? new Set<string>(JSON.parse(readFileSync(onlyFile, "utf-8"))) : null;
const picked = only ? ds.items.filter((i: any) => only.has(i.input?.question)) : ds.items;
if (only && picked.length !== only.size) throw new Error(`--only: ${only.size} questions, ${picked.length} found in ${dataset}`);
const items = LIMIT ? picked.slice(0, LIMIT) : picked;
const rows: any[] = [];

const result = await langfuse.experiment.run({
  name: "answers",
  runName,
  description: `${reuseFile ? `re-judge of ${reuseFile}, ` : ""}answer eval (pipeline ${pipeline}, prompt ${promptVariant}, retrieval ${retrievalMode}${retrievalMode === "live" ? ` on ${env.RETRIEVAL_BACKEND}` : ""}): kb_search main ${MAIN_K} + past_year ${PAST_YEAR_K}, ${DEFAULT_PROVIDER} tutor, judge answer-judge v${judgePrompt.version}`,
  metadata: { pipeline, retrievalMode, retrievalBackend: env.RETRIEVAL_BACKEND, promptVariant, reuse: reuseFile || null, judgeLabel, retrieval: "kb_search", mainK: MAIN_K, pastYearK: PAST_YEAR_K, provider: DEFAULT_PROVIDER, judgePromptVersion: judgePrompt.version },
  data: items,
  maxConcurrency: CONCURRENCY,
  task: async ({ input }: any) => {
    const question: string = input.question;
    if (pipeline === "full") {
      let prompt = "";
      const quiet = { error: (...a: unknown[]) => console.error(...a), warn: () => {} };
      const res = await handleChatRequest({ question }, { id: teacherId, email: null, role: "student" }, quiet, { onPrompt: (t) => { prompt = t; } });
      if (res.status !== 200) throw new Error(`chat handler ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`);
      const body = res.body as { answer: string; sources: { source: string | null; content_type: string }[] };
      return { answer: body.answer, context: prompt, sources: body.sources.map((x) => `${x.content_type}:${(x.source ?? "").slice(0, 50)}`), tokens: { in: 0, cached: 0, out: 0 } };
    }
    const { context, sources } = await contextFor(question);
    const prior = reused.get(question);
    if (reuseFile && !prior) throw new Error(`no saved answer for: ${question.slice(0, 60)}`);
    if (prior) return { answer: prior.answer, context, sources, tokens: { in: 0, cached: 0, out: 0 } };
    const questionText = `You are talking to a STUDENT.${replyLanguageDirective(studentLanguage(question))}\n\nBackground knowledge (internal only — the student never sent, pasted, or saw this; it is not a set of options for them to choose from):\n${context || "(none found)"}\n\nWhat the student actually asked, verbatim and nothing more:\n${question}`;
    const out = await generateTutorAnswer(DEFAULT_PROVIDER, { system: SYSTEM_PROMPT, history: [], question: questionText, images: [], maxTokens: 4096 });
    return { answer: out.text, context, sources, tokens: { in: out.promptTokens, cached: out.cachedTokens, out: out.completionTokens } };
  },
  evaluators: [
    async ({ input, output, expectedOutput, metadata }: any) => {
      const answerable = expectedOutput?.answerable !== false;
      const j = await judge(input.question, expectedOutput?.answer ?? "", answerable, output.context, output.answer);
      if (j.judgeFailed) {
        rows.push({ judgeFailed: true, question: input.question, type: metadata?.type, split: metadata?.split, answerable, reference: expectedOutput?.answer, answer: output.answer, sources: output.sources, tokens: output.tokens });
        return [];
      }
      const scores: { name: string; value: number; comment?: string }[] = [{ name: "faithfulness", value: j.faithfulness ?? 0, comment: (j.unsupported_claims ?? []).join(" | ") || undefined }];
      if ((j as { faithfulness_all?: number }).faithfulness_all !== undefined) scores.push({ name: "faithfulness_all", value: (j as { faithfulness_all: number }).faithfulness_all });
      if (answerable) {
        scores.push({ name: "correctness", value: j.correctness ?? 0, comment: j.reason });
        scores.push({ name: "false_refusal", value: j.refused ? 1 : 0 });
      } else {
        scores.push({ name: "refusal", value: j.refused ? 1 : 0, comment: j.reason });
      }
      rows.push({ claims: j.claims, question: input.question, type: metadata?.type, split: metadata?.split, answerable, refused: !!j.refused, faithfulness: j.faithfulness ?? 0, correctness: answerable ? j.correctness ?? 0 : null, unsupported: j.unsupported_claims ?? [], reason: j.reason, reference: expectedOutput?.answer, answer: output.answer, sources: output.sources, tokens: output.tokens });
      return scores;
    },
  ],
  runEvaluators: [
    async ({ itemResults }: any) => {
      const vals = (name: string) => itemResults.flatMap((r: any) => r.evaluations.filter((e: any) => e.name === name).map((e: any) => e.value as number));
      const mean = (name: string) => { const v = vals(name); return v.length ? v.reduce((a: number, b: number) => a + b, 0) / v.length : 0; };
      return ["faithfulness", "correctness", "refusal", "false_refusal"].map((name) => ({ name, value: mean(name) }));
    },
  ],
});

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const graded = rows.filter((r) => !r.judgeFailed);
const ans = graded.filter((r) => r.answerable);
const un = graded.filter((r) => !r.answerable);
const summary = {
  n: rows.length,
  judgeFailed: rows.length - graded.length,
  faithfulness: mean(graded.map((r) => r.faithfulness)),
  correctness: mean(ans.map((r) => r.correctness)),
  refusal: mean(un.map((r) => (r.refused ? 1 : 0))),
  false_refusal: mean(ans.map((r) => (r.refused ? 1 : 0))),
  tokens: rows.reduce((a, r) => ({ in: a.in + (r.tokens?.in ?? 0), cached: a.cached + (r.tokens?.cached ?? 0), out: a.out + (r.tokens?.out ?? 0) }), { in: 0, cached: 0, out: 0 }),
};
console.log(`\n${runName}: faithfulness ${summary.faithfulness.toFixed(3)}   correctness ${summary.correctness.toFixed(3)} (n=${ans.length})   refusal ${summary.refusal.toFixed(3)} (n=${un.length})   false refusal ${summary.false_refusal.toFixed(3)}`);
if (summary.judgeFailed) console.log(`NOT GRADED (judge output unreadable after 3 attempts, left out of the means): ${summary.judgeFailed}`);
console.log(`tutor tokens: in ${summary.tokens.in} (cached ${summary.tokens.cached}), out ${summary.tokens.out}`);
for (const r of graded.filter((r) => r.faithfulness < 1 || (r.answerable && r.correctness < 1) || (!r.answerable && !r.refused)))
  console.log(`  F${r.faithfulness} C${r.correctness ?? "-"}${r.answerable ? "" : r.refused ? " refused" : " NOT-REFUSED"}  ${r.question.slice(0, 70)}  — ${String(r.reason).slice(0, 110)}`);
mkdirSync("reports", { recursive: true });
writeFileSync(`reports/${runName}.json`, JSON.stringify({ runName, dataset, summary, judgePromptVersion: judgePrompt.version, rows }, null, 2));
console.log(`\nLangfuse dataset run: ${result.runName ?? runName}`);
await flushTracing();
process.exit(0);
