// Builds eval/retrieval-set.json: a labelled set for scripts/eval-retrieval.ts.
// Samples chunks stratified by subject x content_type (plus teacher material),
// and has the tutor model write the question a student would type for each,
// in English AND Malay. The sampled chunk (plus its near-duplicates) is gold.
// Read-only against the DB. Re-running overwrites the set, so results from
// different sets are not comparable — keep the committed one fixed.
//
// Usage: npx tsx src/scripts/build-retrieval-eval.ts [--per-cell 12] [--teacher 30]
import { writeFile } from "node:fs/promises";
import { supabase } from "../lib/supabase.js";
import { anthropic, TUTOR_MODEL } from "../lib/anthropic.js";

const args = process.argv.slice(2);
const opt = (name: string, d: number) => (args.includes(name) ? Number(args[args.indexOf(name) + 1]) : d);
const PER_CELL = opt("--per-cell", 12);
const TEACHER = opt("--teacher", 30);
const SUBJECTS = ["Add Maths", "Mathematics", "Physics", "Chemistry", "Sejarah"];
const TYPES = ["concept", "worked_example", "past_year_question", "formula"];

type Row = { id: string; subject: string; topic: string | null; content_type: string; material_id: string | null; content: string };

// Seeded so the same flags give the same sample.
let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = <T,>(xs: T[], n: number) => [...xs].sort(() => rand() - 0.5).slice(0, n);

async function loadAll(): Promise<Row[]> {
  const rows: Row[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("content_chunks")
      .select("id, subject, topic, content_type, material_id, content")
      .order("id")
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as Row[]));
    if ((data ?? []).length < 1000) break;
  }
  return rows;
}

const TOOL = {
  name: "write_questions",
  description: "Write the questions a student would type that this excerpt answers.",
  input_schema: {
    type: "object" as const,
    properties: {
      usable: { type: "boolean", description: "False if the excerpt is a header, fragment, or too thin to answer any real question." },
      en: { type: "string", description: "The question in English." },
      ms: { type: "string", description: "The same question in Bahasa Melayu." },
    },
    required: ["usable", "en", "ms"],
  },
};

const SYSTEM = `You write evaluation queries for a search engine used by Malaysian SPM students.
Given one excerpt from the knowledge base, write the question a real student would type into a tutor chat that THIS excerpt answers well.
- Sound like a student: short (6-20 words), casual is fine, no "according to the excerpt".
- Do NOT copy distinctive phrases, figure labels ("Rajah 2", "Diagram 5"), exam names, question numbers or option letters. Paraphrase the underlying concept or problem.
- For a past-year question or worked example, ask about the problem the way a stuck student would (e.g. "how do I find m and n if AB + BC = 32 in a triangle").
- Write one English and one Malay version of the same question.
- Set usable=false for headers, tables of contents, fragments, or anything no student would search for.`;

async function questionsFor(r: Row): Promise<{ en: string; ms: string } | null> {
  const msg = await anthropic.messages.create({
    model: TUTOR_MODEL,
    max_tokens: 300,
    thinking: { type: "disabled" as const },
    system: SYSTEM,
    tools: [TOOL],
    tool_choice: { type: "tool", name: TOOL.name },
    messages: [{ role: "user", content: `Subject: ${r.subject}\nTopic: ${r.topic ?? "-"}\n\nExcerpt:\n${r.content.slice(0, 1500)}` }],
  });
  const t = msg.content.find((b) => b.type === "tool_use");
  const inp = t?.input as { usable?: boolean; en?: string; ms?: string } | undefined;
  return inp?.usable && inp.en && inp.ms ? { en: inp.en, ms: inp.ms } : null;
}

async function main() {
  const all = (await loadAll()).filter((r) => r.content.length >= 150);
  const sample: Row[] = [];
  for (const s of SUBJECTS)
    for (const t of TYPES) sample.push(...pick(all.filter((r) => r.subject === s && r.content_type === t && !r.material_id), PER_CELL));
  sample.push(...pick(all.filter((r) => r.material_id), TEACHER));
  console.log(`sampled ${sample.length} chunks`);

  const items: unknown[] = [];
  for (let i = 0; i < sample.length; i += 8) {
    const batch = sample.slice(i, i + 8);
    const out = await Promise.all(batch.map((r) => questionsFor(r).catch((e) => (console.warn(r.id, e.message), null))));
    batch.forEach((r, j) => {
      const q = out[j];
      if (!q) return;
      items.push({
        gold_id: r.id,
        subject: r.subject,
        topic: r.topic,
        content_type: r.content_type,
        teacher: Boolean(r.material_id),
        content_preview: r.content.slice(0, 160),
        q_en: q.en,
        q_ms: q.ms,
      });
    });
    process.stdout.write(`\r${Math.min(i + 8, sample.length)}/${sample.length}`);
  }
  await writeFile("eval/retrieval-set.json", JSON.stringify({ built: new Date().toISOString(), model: TUTOR_MODEL, items }, null, 2));
  console.log(`\nwrote ${items.length} items to eval/retrieval-set.json`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
