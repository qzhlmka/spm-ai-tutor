/**
 * Second pass on drafted golden items (rag-stack Phase 3, golden-v4): finds
 * EVERY page that teaches an item's answer, not just the page it was drafted
 * from.
 *
 * Why: the blind audit for golden-v3 found 9 of 24 pilot items with a wrong or
 * incomplete gold page — the drafter lists the one page it was shown, while the
 * book teaches the same fact on two or three. A retriever that finds one of the
 * others was scored as a miss.
 *
 * Candidates come from the RAW page text, not the retrieval index: the drafted
 * page and its neighbours, plus the pages sharing the most rare words with the
 * reference answer. Claude reads each candidate and keeps the ones a student
 * could learn the answer's core fact or method from on their own (exercise
 * pages, concept maps and answer keys do not count). A question that cites a
 * label only the book knows ("Jadual 3.9", "Aktiviti 4.12") is rewritten.
 *
 *   npx tsx --env-file=.env src/scripts/golden-widen.ts <in.jsonl> <out.jsonl>
 */
import { readFileSync, writeFileSync } from "node:fs";
import type Anthropic from "@anthropic-ai/sdk";
import { TUTOR_MODEL } from "../lib/anthropic.js";
import { flushTracing, tracedMessage } from "../lib/tracing.js";
import { bookMatterPages } from "../rag/book-matter.js";
import { pdfPages, readDocList } from "../rag/docs.js";
import { tokenize } from "../rag/hybrid.js";

const [inFile, outFile] = process.argv.slice(2);
if (!inFile || !outFile) throw new Error("usage: golden-widen <in.jsonl> <out.jsonl>");
const KEYWORD_CANDIDATES = 8;

const files = new Map(readDocList("pilot-docs.txt").map((d) => [d.docId, d.file]));
const books = new Map<string, { pages: string[]; matter: Set<number>; df: Map<string, number> }>();
function book(docId: string) {
  if (!books.has(docId)) {
    const pages = pdfPages(files.get(docId)!).map((p) => p.normalize("NFKC"));
    const df = new Map<string, number>();
    for (const p of pages) for (const t of new Set(tokenize(p))) df.set(t, (df.get(t) ?? 0) + 1);
    books.set(docId, { pages, matter: bookMatterPages(pages), df });
  }
  return books.get(docId)!;
}

/** Pages sharing the most rare words with the answer (IDF-weighted overlap). */
function keywordPages(docId: string, answer: string, k: number): number[] {
  const b = book(docId);
  const n = b.pages.length;
  const terms = [...new Set(tokenize(answer))].filter((t) => t.length > 2 && (b.df.get(t) ?? 0) > 0 && (b.df.get(t) ?? 0) < n * 0.2);
  return b.pages
    .map((p, i) => {
      const have = new Set(tokenize(p));
      return { page: i + 1, score: terms.reduce((a, t) => a + (have.has(t) ? Math.log(n / b.df.get(t)!) : 0), 0) };
    })
    .filter((x) => x.score > 0 && !b.matter.has(x.page))
    .sort((a, b2) => b2.score - a.score)
    .slice(0, k)
    .map((x) => x.page);
}

const TOOL: Anthropic.Tool = {
  name: "judge_pages",
  description: "Say which candidate pages teach the answer, and fix the question if it cites a book-only label.",
  input_schema: {
    type: "object",
    properties: {
      teaching_pages: { type: "array", items: { type: "integer" }, description: "Pages from which a student, reading that page alone, could learn the answer's core fact or method." },
      question: { type: "string", description: "The question, unchanged — or rewritten if it cites a table/figure/activity/example number or other label a student could not know without the book open. Keep the student's voice and language." },
      rewritten: { type: "boolean" },
      note: { type: "string", description: "One line: why these pages, and anything doubtful about the item." },
    },
    required: ["teaching_pages", "question", "rewritten", "note"],
  },
};
const SYSTEM = `You check evaluation items for an SPM tutoring app's page retrieval. For one question and its reference
answer you get candidate pages from a textbook. Mark a page as teaching the answer only if a student reading THAT PAGE
ALONE could learn the answer's core fact or method from it. A page that merely mentions the topic, an exercise or
question page without the answer, a concept map, a summary list of keywords, or an answer key does NOT count. A worked
problem's core is the METHOD, so the page that teaches or demonstrates the method counts even with different numbers.
If no candidate teaches it, return an empty list and say so in the note.`;

const items = readFileSync(inFile, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const out: string[] = [];
for (const item of items) {
  const docId: string = item.expectedOutput.sources[0].doc_id;
  const b = book(docId);
  const drafted: number[] = item.metadata.drafted_from_pages ?? item.expectedOutput.sources.map((s: { page: number }) => s.page);
  const near = drafted.flatMap((p) => [p - 2, p - 1, p, p + 1, p + 2]);
  const candidates = [...new Set([...near, ...keywordPages(docId, item.expectedOutput.answer, KEYWORD_CANDIDATES)])]
    .filter((p) => p >= 1 && p <= b.pages.length && !b.matter.has(p))
    .sort((x, y) => x - y);
  const body = candidates.map((p) => `=== PAGE ${p} ===\n${b.pages[p - 1].replace(/[ \t]+/g, " ").slice(0, 3500)}`).join("\n\n");
  const msg = await tracedMessage("golden-widen", {
    model: TUTOR_MODEL,
    max_tokens: 800,
    thinking: { type: "disabled" as const },
    system: SYSTEM,
    tools: [TOOL],
    tool_choice: { type: "tool", name: TOOL.name },
    messages: [{ role: "user", content: `Question: ${item.input.question}\n\nReference answer: ${item.expectedOutput.answer}\n\n${body}` }],
  });
  const r = (msg.content.find((c) => c.type === "tool_use")?.input ?? {}) as { teaching_pages?: number[]; question?: string; rewritten?: boolean; note?: string };
  const pages = (r.teaching_pages ?? []).filter((p) => candidates.includes(p));
  if (!pages.length) {
    console.log(`  DROPPED (no teaching page): ${item.input.question.slice(0, 80)} — ${r.note}`);
    continue;
  }
  if (r.rewritten && r.question) item.input.question = r.question;
  item.expectedOutput.sources = pages.map((page) => ({ doc_id: docId, page }));
  item.metadata.widen_note = r.note;
  item.metadata.widen_candidates = candidates;
  out.push(JSON.stringify(item));
  console.log(`  ${docId.slice(0, 22)} drafted ${drafted.join("+")} → gold ${pages.join(",")}${r.rewritten ? "  [question rewritten]" : ""}  | ${item.input.question.slice(0, 70)}`);
}
writeFileSync(outFile, out.join("\n") + "\n");
console.log(`\n${out.length}/${items.length} items → ${outFile}`);
await flushTracing();
process.exit(0);
