import { writeFile } from "node:fs/promises";
import path from "node:path";
import { embedPassage } from "../lib/embeddings.js";
import { supabase } from "../lib/supabase.js";
import { openai, CHUNKING_MODEL } from "../lib/openai.js";
import { ocrBukuSelekoh, ocrSkema, type BukuQuestion, type SkemaEntry } from "./past-year-ocr.js";

const BASE_DIR = "./knowledge-bases/additional mathematics";
const CACHE_DIR = "./.cache/past-year-ocr";

const BUKU_PDF = path.join(BASE_DIR, "ADDMATH_BUKU SELEKOH AKHIR SPM 2024.pdf");
const SKEMA_F4_PDF = path.join(BASE_DIR, "SKEMA SELEKOH - ADDMATH F4.pdf");
const SKEMA_F5_PDF = path.join(BASE_DIR, "SKEMA SELEKOH - ADDMATH F5.pdf");

// Existing topic taxonomy already in content_chunks (subject = "Add Maths"), confirmed
// directly against the live DB (`select distinct topic from content_chunks where
// subject='Add Maths'`) — every chapter_header.topic_en we detect must land on one
// of these exact strings, or it's flagged instead of silently creating a new,
// possibly-inconsistent topic label.
const KNOWN_TOPICS = new Set([
  "Circular Measure",
  "Coordinate Geometry",
  "Differentiation",
  "Functions",
  "Index Numbers",
  "Indices, Surds and Logarithms",
  "Integration",
  "Kinematics of Linear Motion",
  "Linear Law",
  "Linear Programming",
  "Permutation and Combination",
  "Probability Distribution",
  "Progressions",
  "Quadratic Functions",
  "Solution of Triangles",
  "Systems of Equations",
  "Trigonometric Functions",
  "Vectors",
]);

// Buku Selekoh's own chapter banners sometimes use the singular form. Map known
// variants onto the exact DB string rather than flagging them as new topics.
const TOPIC_SYNONYMS: Record<string, string> = {
  "Function": "Functions",
  "Progression": "Progressions",
  "Vector": "Vectors",
  "Solution of Triangle": "Solution of Triangles",
  "Indices and Logarithms": "Indices, Surds and Logarithms",
  "Indices, Surds and Logarithm": "Indices, Surds and Logarithms",
  "Index Number": "Index Numbers",
  // "Locus" is its own chapter banner in this book but isn't a separate topic in
  // the DB taxonomy — it's coordinate-geometry content (equation of a locus).
  "Locus": "Coordinate Geometry",
};

function normalizeTopic(topic: string): string {
  return TOPIC_SYNONYMS[topic] ?? topic;
}

// A page that failed OCR after retries falls back to `{}` (no questions/entries at
// all), and even a successfully-parsed page can have an entry where the model
// filled a field with null instead of a string when it couldn't tell (e.g. a
// continuation row missing a clear header). Either way, an entry without a usable
// label can't be matched or merged, so it's dropped rather than crashing the run.
function hasValidLabel(item: { source_exam: unknown; year: unknown; soalan_no: unknown }): boolean {
  return typeof item.source_exam === "string" && item.source_exam.trim() !== ""
    && typeof item.year === "number"
    && typeof item.soalan_no === "string" && item.soalan_no.trim() !== "";
}

function normalizeSourceExam(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/\bPERCUBAAN\b/g, "")
    .replace(/\bTRIAL\b/g, "")
    .replace(/\bNEGERI\b/g, "")
    .replace(/\b(19|20)\d{2}\b/g, "") // the model doesn't consistently strip the year out of source_exam itself
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}

// Skema sometimes labels a row with its exact sub-part, e.g. "5(a)(i)", while Buku
// Selekoh just says "5" for the whole question — strip everything after the leading
// question number so both sides key on the same base identifier.
function baseSoalanNo(raw: string): string {
  return raw.trim().match(/^[0-9]+[a-zA-Z]?/)?.[0] ?? raw.trim();
}

function matchKey(source_exam: string, year: number, soalan_no: string): string {
  return `${normalizeSourceExam(source_exam)}|${year}|${baseSoalanNo(soalan_no)}`;
}

// A multi-part question/answer spanning several pages has no repeated header on
// continuation pages, so each page's OCR pass emits it as a separate fragment
// sharing the same (source_exam, year, soalan_no) label. Merge adjacent fragments
// (in original page order) that share a match key into one combined record before
// matching — otherwise the same answer gets attached to 2-3 duplicate DB rows.
function mergeAdjacentByKey<T extends { source_exam: string; year: number; soalan_no: string }>(
  items: T[],
  mergeText: (a: T, b: T) => Partial<T>,
): T[] {
  const merged: T[] = [];
  for (const item of items) {
    const prev = merged[merged.length - 1];
    if (prev && matchKey(prev.source_exam, prev.year, prev.soalan_no) === matchKey(item.source_exam, item.year, item.soalan_no)) {
      Object.assign(prev, mergeText(prev, item));
    } else {
      merged.push({ ...item });
    }
  }
  return merged;
}

function inferDifficulty(marks: number | null): "easy" | "medium" | "hard" {
  if (marks === null) return "medium";
  if (marks <= 2) return "easy";
  if (marks <= 5) return "medium";
  return "hard";
}

async function runPool<T, R>(items: T[], size: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return results;
}

const VERIFY_SYSTEM = `You check whether a marking scheme is the correct answer key for a given Add Maths exam question.
Both were matched by a label (exam source + year + question number) that can occasionally collide with an unrelated
question sharing the same label — your job is to catch those real collisions, not to demand perfect verification.

The question text may reference a diagram you cannot see, and OCR transcription of both texts is imperfect (stray
symbols, garbled characters, inconsistent notation). Judge leniently on those grounds: focus on whether the
marking scheme is clearly ABOUT the same problem — same function names/variables (f, g, h, p, q, etc.), same type
of task (e.g. finding an inverse, composite function, quadratic vertex, absolute value graph), and, where the
question gives an explicit "Ans:" line, whether the marking scheme's results are consistent with it.

Mark invalid ONLY if there's a clear, confident mismatch: different functions/variables entirely, a different
mathematical topic or operation, or a final answer that contradicts an explicit "Ans:" line. If the marking scheme
plausibly solves the stated question and you cannot point to a concrete contradiction, mark it valid — do not
reject merely because a diagram is missing or wording differs.

Respond with strict JSON only: {"valid": boolean}`;

async function verifyMatch(question_text: string, marking_scheme_text: string): Promise<boolean> {
  const completion = await openai.chat.completions.create({
    model: CHUNKING_MODEL,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: VERIFY_SYSTEM },
      { role: "user", content: `Question:\n${question_text}\n\nMarking Scheme:\n${marking_scheme_text}` },
    ],
  });
  try {
    return Boolean(JSON.parse(completion.choices[0].message.content ?? "{}").valid);
  } catch {
    return false;
  }
}

interface MatchedChunk {
  topic: string;
  subtopic: string;
  content_type: "past_year_question";
  difficulty: "easy" | "medium" | "hard";
  source: string;
  content: string;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const smokeTest = process.argv.includes("--smoke-test");
  const maxPages = smokeTest ? 14 : undefined;
  const cacheSuffix = smokeTest ? "-smoke" : "";

  console.log("=== OCR: Buku Selekoh (questions) ===");
  const bukuPages = await ocrBukuSelekoh(BUKU_PDF, path.join(CACHE_DIR, `buku${cacheSuffix}`), maxPages);
  console.log("=== OCR: Skema F4 (answers, Form 4) ===");
  const skemaF4Pages = await ocrSkema(SKEMA_F4_PDF, path.join(CACHE_DIR, `skema-f4${cacheSuffix}`), maxPages);
  console.log("=== OCR: Skema F5 (answers, Form 5) ===");
  const skemaF5Pages = await ocrSkema(SKEMA_F5_PDF, path.join(CACHE_DIR, `skema-f5${cacheSuffix}`), maxPages);

  // Carry forward chapter headers across pages (banners only appear on section-start pages).
  let currentTopicByForm: Record<4 | 5, { bab_number: number; topic_my: string; topic_en: string } | null> = {
    4: null,
    5: null,
  };
  const rawBukuQuestions: { form: 4 | 5; topic_en: string; q: BukuQuestion }[] = [];
  let droppedInvalidLabel = 0;
  // A "Kertas 1/2" (Paper 1/2) section banner within a chapter can get misread as a
  // chapter_header. Accepting it would overwrite the real carried-forward topic and
  // mislabel every question until the next real chapter banner — worse than a
  // missing topic, since it's silently wrong rather than absent. Reject it here.
  const isPaperMarker = (h: { topic_my: string; topic_en: string }) =>
    /^kertas\s*\d+$/i.test(h.topic_my.trim()) || /^paper\s*\d+$/i.test(h.topic_en.trim());
  for (const page of bukuPages) {
    if (page.chapter_header && !isPaperMarker(page.chapter_header)) {
      currentTopicByForm[page.chapter_header.form] = page.chapter_header;
    }
    for (const q of page.questions ?? []) {
      if (!hasValidLabel(q)) {
        droppedInvalidLabel++;
        continue;
      }
      // Assume the most recently seen chapter header (either form) applies —
      // Buku Selekoh pages are strictly sequential by chapter.
      const form = page.chapter_header?.form ?? (currentTopicByForm[4] && !currentTopicByForm[5] ? 4 : 5);
      const topic = currentTopicByForm[form] ?? currentTopicByForm[4] ?? currentTopicByForm[5];
      if (!topic) {
        console.warn(`Skipping question with no known chapter context (page ${page.page}, soalan ${q.soalan_no})`);
        continue;
      }
      rawBukuQuestions.push({ form, topic_en: normalizeTopic(topic.topic_en), q });
    }
  }

  const mergedBukuFlat = mergeAdjacentByKey(
    rawBukuQuestions.map((r) => ({ ...r.q, form: r.form, topic_en: r.topic_en })),
    (a, b) => ({
      question_text: `${a.question_text}\n\n${b.question_text}`,
      marks: (a.marks ?? 0) + (b.marks ?? 0) || a.marks || b.marks,
      kertas: a.kertas ?? b.kertas,
    }),
  );
  const bukuQuestions = mergedBukuFlat.map((q) => ({ form: q.form, topic_en: q.topic_en, q }));

  function indexSkema(pages: typeof skemaF4Pages): Map<string, SkemaEntry[]> {
    const flat = pages.flatMap((page) => page.entries ?? []).filter((e) => {
      const valid = hasValidLabel(e);
      if (!valid) droppedInvalidLabel++;
      return valid;
    });
    const mergedFlat = mergeAdjacentByKey(flat, (a, b) => ({
      marking_scheme_text: `${a.marking_scheme_text}\n${b.marking_scheme_text}`,
      total_marks: (a.total_marks ?? 0) + (b.total_marks ?? 0) || a.total_marks || b.total_marks,
    }));
    const index = new Map<string, SkemaEntry[]>();
    for (const e of mergedFlat) {
      const key = matchKey(e.source_exam, e.year, e.soalan_no);
      const list = index.get(key) ?? [];
      list.push(e);
      index.set(key, list);
    }
    return index;
  }
  const skemaF4Index = indexSkema(skemaF4Pages);
  const skemaF5Index = indexSkema(skemaF5Pages);

  const unmatched: {
    form: 4 | 5;
    topic_en: string;
    source_exam: string;
    year: number;
    soalan_no: string;
    marks: number | null;
    reason: string;
    question_text: string;
    candidate_answers?: string[];
  }[] = [];
  const topicMismatches = new Set<string>();

  // Label collisions do happen (the same source+year+soalan legitimately or
  // accidentally reused for a different sub-question elsewhere in the book), so a
  // label match alone isn't trustworthy — verify each candidate against the actual
  // question content before accepting it, since a wrong Q/A pairing actively
  // misleads a student rather than just being missing content.
  console.log("\nVerifying matched pairs against question content...");
  const candidates = bukuQuestions.flatMap(({ form, topic_en, q }) => {
    const index = form === 4 ? skemaF4Index : skemaF5Index;
    const key = matchKey(q.source_exam, q.year, q.soalan_no);
    const answers = index.get(key);
    if (!answers) {
      unmatched.push({ form, topic_en, source_exam: q.source_exam, year: q.year, soalan_no: q.soalan_no, marks: q.marks, reason: "no label match", question_text: q.question_text });
      return [];
    }
    return answers.map((answer) => ({ form, topic_en, q, answer }));
  });

  const verified = await runPool(candidates, 8, async (c) => ({
    ...c,
    valid: await verifyMatch(c.q.question_text, c.answer.marking_scheme_text),
  }));

  const matched: MatchedChunk[] = [];
  const grouped = new Map<string, typeof verified>();
  for (const v of verified) {
    const key = matchKey(v.q.source_exam, v.q.year, v.q.soalan_no) + "|" + v.q.question_text.slice(0, 40);
    const list = grouped.get(key) ?? [];
    list.push(v);
    grouped.set(key, list);
  }
  for (const group of grouped.values()) {
    const winner = group.find((v) => v.valid);
    const { form, topic_en, q } = group[0];
    if (!winner) {
      unmatched.push({
        form,
        topic_en,
        source_exam: q.source_exam,
        year: q.year,
        soalan_no: q.soalan_no,
        marks: q.marks,
        reason: `label matched ${group.length} candidate(s) but none verified as the correct answer`,
        question_text: q.question_text,
        candidate_answers: group.map((v) => v.answer.marking_scheme_text),
      });
      continue;
    }
    if (!KNOWN_TOPICS.has(topic_en)) {
      topicMismatches.add(topic_en);
    }
    matched.push({
      topic: topic_en,
      subtopic: `Form ${form}`,
      content_type: "past_year_question",
      difficulty: inferDifficulty(q.marks ?? winner.answer.total_marks),
      source: `${q.source_exam} ${q.year} (Soalan ${q.soalan_no})`,
      content: `Question:\n${q.question_text}\n\nMarking Scheme:\n${winner.answer.marking_scheme_text}`,
    });
  }

  // Unpaired questions (no verified marking scheme) still go into the KB, just
  // without a "Marking Scheme" section — the tutor solves them live instead of
  // referencing an answer key. Every one of these has a valid label (invalid-label
  // drops never reached `unmatched`), so topic/source are safe to build here.
  const questionOnlyChunks: MatchedChunk[] = unmatched
    .filter((u) => KNOWN_TOPICS.has(u.topic_en) || (topicMismatches.add(u.topic_en), false))
    .map((u) => ({
      topic: u.topic_en,
      subtopic: `Form ${u.form}`,
      content_type: "past_year_question",
      difficulty: inferDifficulty(u.marks),
      source: `${u.source_exam} ${u.year} (Soalan ${u.soalan_no})`,
      content: `Question:\n${u.question_text}`,
    }));

  console.log(`\nBuku questions extracted: ${bukuQuestions.length}`);
  console.log(`Dropped for missing/invalid label (null field or failed OCR page): ${droppedInvalidLabel}`);
  console.log(`Matched + verified (with marking scheme): ${matched.length}`);
  console.log(`Unmatched (question-only, no marking scheme): ${questionOnlyChunks.length}`);
  if (topicMismatches.size > 0) {
    console.warn(`Topics NOT in existing DB taxonomy (need manual mapping): ${[...topicMismatches].join(", ")}`);
  }

  await writeFile(path.join(CACHE_DIR, "unmatched.json"), JSON.stringify(unmatched, null, 2), "utf-8");
  await writeFile(path.join(CACHE_DIR, "matched-preview.json"), JSON.stringify(matched.slice(0, 20), null, 2), "utf-8");
  await writeFile(path.join(CACHE_DIR, "question-only-preview.json"), JSON.stringify(questionOnlyChunks.slice(0, 20), null, 2), "utf-8");

  const allChunks = [...matched, ...questionOnlyChunks];

  if (dryRun) {
    await writeFile(path.join(CACHE_DIR, "matched-full.json"), JSON.stringify(matched, null, 2), "utf-8");
    await writeFile(path.join(CACHE_DIR, "question-only-full.json"), JSON.stringify(questionOnlyChunks, null, 2), "utf-8");
    console.log(`\nDry run complete. Full matched set: ${path.join(CACHE_DIR, "matched-full.json")}`);
    console.log(`Question-only set: ${path.join(CACHE_DIR, "question-only-full.json")}`);
    console.log(`Unmatched log (incl. rejected candidates): ${path.join(CACHE_DIR, "unmatched.json")}`);
    return;
  }

  // Postgres text columns reject literal null bytes outright ("22P05: unsupported
  // Unicode escape sequence...cannot be converted to text") -- OCR occasionally
  // emits one for a glyph it could not resolve. Strip null bytes (and other C0
  // control chars except newline/tab) before insert.
  const CONTROL_CHAR_PATTERN = new RegExp(String.fromCharCode(91) + "\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F" + String.fromCharCode(93), "g");
  const sanitize = (s: string) => s.replace(CONTROL_CHAR_PATTERN, "");

  console.log(`\nEmbedding and inserting ${allChunks.length} chunks (${matched.length} with marking scheme, ${questionOnlyChunks.length} question-only)...`);
  for (const [i, chunk] of allChunks.entries()) {
    const content = sanitize(chunk.content);
    const source = sanitize(chunk.source);
    const embedding = await embedPassage(content);
    const { error } = await supabase.from("content_chunks").insert({
      exam_board: "SPM",
      subject: "Add Maths",
      topic: chunk.topic,
      subtopic: chunk.subtopic,
      content_type: chunk.content_type,
      difficulty: chunk.difficulty,
      content,
      source,
      embedding,
    });
    if (error) {
      console.error(`Insert failed for chunk ${i + 1}/${allChunks.length}:`, error.message);
      throw error;
    }
    if ((i + 1) % 25 === 0 || i + 1 === allChunks.length) {
      console.log(`Inserted ${i + 1}/${allChunks.length}`);
    }
  }

  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
