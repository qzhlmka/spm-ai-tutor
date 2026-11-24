/** Runs retrieval + the diagram step for a few questions and saves any figure it would show.
 *   RETRIEVAL_BACKEND=kb_chunks npx tsx --env-file=.env src/scripts/test-textbook-figures.ts <outDir> "question" ... */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveExamPageImages, retrieveContext, wantsTextbookFigure } from "../lib/chat-handler.js";
import { parseExamFilterFromQuestion } from "../lib/exam-label.js";
import { supabase } from "../lib/supabase.js";
import { flushTracing } from "../lib/tracing.js";

const [outDir, ...questions] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const { data: teacher } = await supabase.from("users").select("id").eq("role", "teacher").limit(1).single();
for (const [i, question] of questions.entries()) {
  const r = await retrieveContext({ userId: teacher!.id, question, history: [], examFilter: parseExamFilterFromQuestion(question), pastYearSubjectUnknown: false, log: console });
  const withImg = (r?.retrieved ?? []).filter((c) => c.source_page_images?.length);
  const t = Date.now();
  const imgs = await resolveExamPageImages(teacher!.id, question, null, r?.retrieved ?? [], console);
  console.log(`\n[${i + 1}] ${question}\n  asks for figure: ${wantsTextbookFigure(question)} | chunks with page image: ${withImg.length} (${withImg.slice(0, 3).map((c) => c.source).join("; ")})\n  shown: ${imgs.dataUrls.length} (${imgs.kind ?? "-"}) in ${Date.now() - t} ms`);
  imgs.dataUrls.forEach((u, j) => writeFileSync(path.join(outDir, `q${i + 1}-${j + 1}.png`), Buffer.from(u.split(",")[1], "base64")));
}
await flushTracing();
process.exit(0);
