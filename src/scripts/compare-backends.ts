/** Side-by-side context blocks from retrieveContext on content_chunks vs kb_chunks.
 * No answer is generated; the teacher relevance judge still runs (one small call per question per backend). */
import { env } from "../lib/env.js";
import { retrieveContext } from "../lib/chat-handler.js";
import { parseExamFilterFromQuestion } from "../lib/exam-label.js";
import { supabase } from "../lib/supabase.js";
import { flushTracing } from "../lib/tracing.js";

const questions = process.argv.slice(2);
const { data: teacher } = await supabase.from("users").select("id").eq("role", "teacher").limit(1).single();
for (const question of questions) {
  console.log(`\n### ${question}`);
  for (const backend of ["content_chunks", "kb_chunks"] as const) {
    (env as { RETRIEVAL_BACKEND: string }).RETRIEVAL_BACKEND = backend;
    const t = Date.now();
    const r = await retrieveContext({ userId: teacher!.id, question, history: [], examFilter: parseExamFilterFromQuestion(question), pastYearSubjectUnknown: false, log: console });
    console.log(`  [${backend}] ${Date.now() - t} ms, ${r?.retrieved.length} chunks, teacher gated ${r?.gatedTeacherChunkIds.size}, exam ${r?.examChunks.length}`);
    for (const c of r?.retrieved ?? []) console.log(`    ${r!.gatedTeacherChunkIds.has(c.id) ? "T" : " "} ${c.content_type.padEnd(18)} ${(c.subject ?? "").padEnd(10)} ${(c.source ?? "").replace(/\s+/g, " ").slice(0, 70)}`);
  }
}
await flushTracing();
process.exit(0);
