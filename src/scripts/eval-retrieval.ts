// Scores first-turn retrieval against eval/retrieval-set.json (built by
// build-retrieval-eval.ts). Read-only; no model calls.
//
// Replicates the lanes handleChatRequest() runs for a question with no prior
// turn, using its exported constants: whole-KB vector (5), Malay->English
// rewrite (5), teacher vector (>= recall floor, up to 6), teacher lexical (2),
// merged in the same order and capped at MAX_CONTEXT_CHUNKS. Two deliberate
// differences: the teacher relevance JUDGE is skipped (everything clearing the
// recall floor is kept, which floods every non-Chemistry question with ~7
// Chemistry teacher chunks; pass --judge to run the real judge, ~$2-3/run),
// and the exam lane is skipped (the set's questions never name a paper).
//
// Gold = item.gold_ids: the sampled chunk plus any chunk whose embedding was
// >= 0.97 cosine to it when the set was built (exact/near copies across
// files), so retrieving a duplicate isn't scored as a miss.
//
// Usage: npx tsx src/scripts/eval-retrieval.ts [--judge] [--lang en|ms|both] [--out eval/results-<date>.json]
import { readFile, writeFile } from "node:fs/promises";
import { supabase } from "../lib/supabase.js";
import { embedQuery } from "../lib/embeddings.js";
import { rewriteMalayTerms } from "../lib/query-glossary.js";
import { flushTracing } from "../lib/tracing.js";
import {
  MAX_CONTEXT_CHUNKS,
  TEACHER_MATERIAL_CONTEXT_LIMIT,
  TEACHER_MATERIAL_FETCH_COUNT,
  TEACHER_MATERIAL_LEXICAL_CONTEXT_LIMIT,
  TEACHER_MATERIAL_LEXICAL_FETCH_COUNT,
  TEACHER_MATERIAL_MIN_LEXICAL_RANK,
  TEACHER_MATERIAL_MIN_LEXICAL_TERMS,
  TEACHER_MATERIAL_MIN_SIMILARITY,
  judgeTeacherMaterialRelevance,
} from "../lib/chat-handler.js";

type Item = { gold_id: string; gold_ids: string[]; subject: string; topic: string | null; content_type: string; teacher: boolean; q_en: string; q_ms: string };
type Hit = { id: string; subject?: string | null; topic?: string | null; similarity?: number; rank?: number; matched_terms?: number };

const args = process.argv.slice(2);
const langArg = args.includes("--lang") ? args[args.indexOf("--lang") + 1] : "both";
const useJudge = args.includes("--judge");
let judgeUserId = "";
const outPath = args.includes("--out") ? args[args.indexOf("--out") + 1] : `eval/results-${new Date().toISOString().slice(0, 10)}.json`;

async function rpc<T>(name: string, params: Record<string, unknown>): Promise<T[]> {
  // Retried: a run is ~1,500 RPCs and one transient "fetch failed" otherwise
  // throws away the whole run.
  for (let attempt = 1; ; attempt++) {
    const { data, error } = await supabase.rpc(name, params);
    if (!error) return (data ?? []) as T[];
    if (attempt >= 4) throw new Error(`${name}: ${error.message}`);
    await new Promise((r) => setTimeout(r, 1000 * attempt));
  }
}

async function retrieve(q: string) {
  const rewritten = rewriteMalayTerms(q);
  const [emb, remb] = await Promise.all([embedQuery(q), rewritten ? embedQuery(rewritten) : Promise.resolve(null)]);
  const [kb, teacher, lexical, rw] = await Promise.all([
    rpc<Hit>("match_content_chunks", { query_embedding: emb, match_count: 5 }),
    rpc<Hit>("match_teacher_materials", { query_embedding: emb, match_count: TEACHER_MATERIAL_FETCH_COUNT }),
    rpc<Hit>("match_teacher_materials_lexical", { query_text: q, match_count: TEACHER_MATERIAL_LEXICAL_FETCH_COUNT }),
    remb ? rpc<Hit>("match_content_chunks", { query_embedding: remb, match_count: 5 }) : Promise.resolve([] as Hit[]),
  ]);
  let tv = teacher.filter((c) => (c.similarity ?? 0) >= TEACHER_MATERIAL_MIN_SIMILARITY);
  if (useJudge && tv.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const verdict = await judgeTeacherMaterialRelevance(judgeUserId, q, "", tv as any, console);
    tv = tv.filter((c) => verdict.relevant.has(c.id));
  }
  tv = tv.slice(0, TEACHER_MATERIAL_CONTEXT_LIMIT);
  const tvIds = new Set(tv.map((c) => c.id));
  const lx = lexical
    .filter((c) => (c.rank ?? 0) >= TEACHER_MATERIAL_MIN_LEXICAL_RANK && (c.matched_terms ?? 0) >= TEACHER_MATERIAL_MIN_LEXICAL_TERMS && !tvIds.has(c.id))
    .slice(0, TEACHER_MATERIAL_LEXICAL_CONTEXT_LIMIT);
  const seen = new Set<string>();
  const merged = [...tv.map((c) => ({ ...c, lane: "teacher" })), ...lx.map((c) => ({ ...c, lane: "lexical" })), ...kb.map((c) => ({ ...c, lane: "kb" })), ...rw.map((c) => ({ ...c, lane: "rewrite" }))]
    .filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)))
    .slice(0, MAX_CONTEXT_CHUNKS);
  return { merged, rewritten: Boolean(rewritten) };
}

const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : "-");

async function main() {
  if (useJudge) {
    // The judge records its token cost against a user; a teacher account is
    // exempt from the student daily cap, so a full run can't lock anyone out.
    const { data } = await supabase.from("users").select("id").eq("role", "teacher").limit(1).single();
    if (!data) throw new Error("--judge needs a teacher account to bill usage to");
    judgeUserId = data.id;
  }
  const { items } = JSON.parse(await readFile("eval/retrieval-set.json", "utf8")) as { items: Item[] };
  const langs = langArg === "both" ? (["en", "ms"] as const) : ([langArg] as ("en" | "ms")[]);
  const meta = new Map<string, { subject: string; topic: string | null }>();
  const rows: Record<string, unknown>[] = [];

  let done = 0;
  for (const it of items) {
    const gold = new Set(it.gold_ids ?? [it.gold_id]);
    for (const lang of langs) {
      const q = lang === "en" ? it.q_en : it.q_ms;
      const { merged, rewritten } = await retrieve(q);
      // subject/topic of retrieved chunks (RPCs may not return topic)
      const missing = merged.map((m) => m.id).filter((id) => !meta.has(id));
      if (missing.length) {
        const { data } = await supabase.from("content_chunks").select("id, subject, topic").in("id", missing);
        for (const r of data ?? []) meta.set(r.id, { subject: r.subject, topic: r.topic });
      }
      const rank = merged.findIndex((m) => gold.has(m.id));
      const subj = merged.filter((m) => meta.get(m.id)?.subject === it.subject).length;
      const top = merged.filter((m) => meta.get(m.id)?.subject === it.subject && meta.get(m.id)?.topic === it.topic).length;
      rows.push({
        gold_id: it.gold_id, subject: it.subject, topic: it.topic, content_type: it.content_type, teacher: it.teacher, lang, question: q, rewritten,
        hit: rank >= 0, rank: rank >= 0 ? rank + 1 : null, hit_lane: rank >= 0 ? merged[rank].lane : null,
        n: merged.length, same_subject: subj, same_topic: top, retrieved: merged.map((m) => m.id),
      });
    }
    process.stdout.write(`\r${++done}/${items.length}`);
  }
  console.log();

  const groups: [string, (r: Record<string, unknown>) => string][] = [
    ["overall", () => "all"], ["lang", (r) => r.lang as string], ["subject", (r) => r.subject as string],
    ["content_type", (r) => r.content_type as string], ["teacher", (r) => (r.teacher ? "teacher" : "textbook")],
    ["subject x lang", (r) => `${r.subject} / ${r.lang}`],
  ];
  for (const [title, key] of groups) {
    console.log(`\n== ${title}`);
    const by = new Map<string, Record<string, unknown>[]>();
    for (const r of rows) by.set(key(r), [...(by.get(key(r)) ?? []), r]);
    console.log(`  ${"group".padEnd(26)} ${"n".padStart(4)}  hit@12   MRR    subj-prec  topic-any`);
    for (const [k, rs] of [...by].sort()) {
      const hits = rs.filter((r) => r.hit).length;
      const mrr = rs.reduce((s, r) => s + (r.rank ? 1 / (r.rank as number) : 0), 0) / rs.length;
      const sp = rs.reduce((s, r) => s + (r.same_subject as number) / Math.max(1, r.n as number), 0) / rs.length;
      const ta = rs.filter((r) => (r.same_topic as number) > 0).length;
      console.log(`  ${k.padEnd(26)} ${String(rs.length).padStart(4)}  ${pct(hits, rs.length).padStart(6)}  ${mrr.toFixed(3)}  ${(100 * sp).toFixed(1).padStart(7)}%  ${pct(ta, rs.length).padStart(8)}`);
    }
  }
  console.log("\n== which lane surfaced the gold chunk (hits only)");
  const lanes = new Map<string, number>();
  for (const r of rows) if (r.hit_lane) lanes.set(r.hit_lane as string, (lanes.get(r.hit_lane as string) ?? 0) + 1);
  for (const [k, v] of lanes) console.log(`  ${k.padEnd(10)} ${v}`);
  await writeFile(outPath, JSON.stringify({ ran: new Date().toISOString(), rows }, null, 2));
  console.log(`\nper-query results: ${outPath}`);
  await flushTracing();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
