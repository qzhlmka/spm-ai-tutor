import { readFile, writeFile } from "node:fs/promises";
import { embedPassage } from "../lib/embeddings.js";
import { supabase } from "../lib/supabase.js";
import { looksLikeMcq } from "./ingest.js";
import {
  ocrBukuSelekoh,
  ocrSkema,
  ocrQuiz,
  type BukuPageResult,
  type SkemaPageResult,
  type QuizPageResult,
  type BukuQuestion,
} from "./physics-past-year-ocr.js";

// Unlike Add Maths (src/ingest/ingest-past-year.ts), matching here doesn't need
// cross-exam-label normalization or adversarial LLM verification: Buku Selekoh's
// own running question number (reset per chapter) is, by construction, the exact
// same numbering Skema's answer key uses for that chapter. The match key is just
// (form, bab_number, question_no) — a clean 1:1 relationship, not a many-candidate
// disambiguation problem. Given the lower stakes of a wrong single MCQ letter vs.
// Add Maths' full worked solutions, this skips the verification LLM pass.

const BASE_DIR = "./knowledge-bases/physics";
const CACHE_DIR = "./.cache/physics-past-year-ocr";
const BUKU_PDF = `${BASE_DIR}/FIZIK_BUKU SELEKOH AKHIR SPM 2024.pdf`;
const SKEMA_F4_PDF = `${BASE_DIR}/SKEMA SELEKOH - FIZIK F4 (1).pdf`;
const SKEMA_F5_PDF = `${BASE_DIR}/SKEMA SELEKOH - FIZIK F5 (1).pdf`;
const QUIZ_PDF = `${BASE_DIR}/KM26-5-F5-FIZIK.pdf`;

const KNOWN_TOPICS = new Set([
  "Measurement",
  "Force and Motion I",
  "Gravitation",
  "Heat",
  "Waves",
  "Light and Optics",
  "Force and Motion II",
  "Pressure",
  "Electricity",
  "Electromagnetism",
  "Electronics",
  "Nuclear Physics",
  "Quantum Physics",
]);

const TOPIC_SYNONYMS: Record<string, string> = {
  "Force And Motion I": "Force and Motion I",
  "Force And Motion II": "Force and Motion II",
  "Force and Motion 1": "Force and Motion I",
  "Force and Motion 2": "Force and Motion II",
  "Light And Optics": "Light and Optics",
  "Lights and Optics": "Light and Optics",
  "Lights And Optic": "Light and Optics",
  "Physics Nuclear": "Nuclear Physics",
  "Physics Quantum": "Quantum Physics",
};

function normalizeTopic(topic: string): string {
  const trimmed = topic.trim();
  return TOPIC_SYNONYMS[trimmed] ?? trimmed;
}

// The OCR model occasionally misreads a numbered subsection heading as the
// top-level "BAB N" banner despite the prompt instructing otherwise, corrupting
// currentHeader's topic_en until the next real banner. These specific subsection
// names are unambiguous KSSM subtopics of one known chapter, so map them back to
// their real topic rather than silently dropping every question on those pages.
const SUBTOPIC_FALLBACK: Record<string, string> = {
  "Man-Made Satellite": "Gravitation",
  "Specific Heat Capacity": "Heat",
  "Thermal Equilibrium": "Heat",
  "Gas Law": "Pressure",
  "Wave": "Waves",
  "Electromagnetic Wave": "Waves",
  "Electrical Energy And Power": "Electricity",
  "Transformer": "Electromagnetism",
  "Electromagnet": "Electromagnetism",
  "Nuclear Energy": "Nuclear Physics",
};


// Postgres text columns reject literal null bytes outright — OCR occasionally
// emits one for an unresolvable glyph. Strip C0 control chars except newline/tab.
const CONTROL_CHAR_PATTERN = new RegExp(String.fromCharCode(91) + "\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F" + String.fromCharCode(93), "g");
const sanitize = (s: string) => s.replace(CONTROL_CHAR_PATTERN, "");

interface MatchedChunk {
  topic: string;
  subtopic: string;
  content: string;
  source: string | null;
}

function mergeAdjacentBukuQuestions(
  pages: BukuPageResult[],
): { form: 4 | 5; bab_number: number; topic_en: string; question: BukuQuestion }[] {
  const flat: { form: 4 | 5; bab_number: number; topic_en: string; question: BukuQuestion }[] = [];
  let currentHeader: { form: 4 | 5; bab_number: number; topic_en: string } | null = null;

  for (const page of pages ?? []) {
    if (page?.chapter_header) {
      currentHeader = {
        form: page.chapter_header.form,
        bab_number: page.chapter_header.bab_number,
        topic_en: normalizeTopic(page.chapter_header.topic_en),
      };
    }
    for (const q of page?.questions ?? []) {
      if (!currentHeader || typeof q.question_no !== "number") continue;
      const last = flat[flat.length - 1];
      if (
        last &&
        last.form === currentHeader.form &&
        last.bab_number === currentHeader.bab_number &&
        last.question.question_no === q.question_no
      ) {
        // Same question continuing onto this page (split across pages) — merge text.
        last.question.question_text += `\n${q.question_text}`;
        last.question.source_exam ??= q.source_exam;
      } else {
        flat.push({ ...currentHeader, question: { ...q } });
      }
    }
  }
  return flat;
}

function indexSkemaEntries(pages: SkemaPageResult[]): Map<string, "A" | "B" | "C" | "D"> {
  const map = new Map<string, "A" | "B" | "C" | "D">();
  let currentBab: number | null = null;
  for (const page of pages ?? []) {
    if (page?.chapter_header) currentBab = page.chapter_header.bab_number;
    for (const e of page?.entries ?? []) {
      if (currentBab === null || typeof e.question_no !== "number" || !e.answer) continue;
      map.set(`${currentBab}:${e.question_no}`, e.answer);
    }
  }
  return map;
}

async function main() {
  console.log("=== OCR: Buku Selekoh (questions) ===");
  const bukuPages = await ocrBukuSelekoh(BUKU_PDF, `${CACHE_DIR}/buku`);
  console.log("=== OCR: Skema F4 (answers) ===");
  const skemaF4Pages = await ocrSkema(SKEMA_F4_PDF, `${CACHE_DIR}/skema-f4`);
  console.log("=== OCR: Skema F5 (answers) ===");
  const skemaF5Pages = await ocrSkema(SKEMA_F5_PDF, `${CACHE_DIR}/skema-f5`);
  console.log("=== OCR: Weekly quiz (no answer key) ===");
  const quizPages: QuizPageResult[] = await ocrQuiz(QUIZ_PDF, `${CACHE_DIR}/quiz`);

  const bukuQuestions = mergeAdjacentBukuQuestions(bukuPages);
  const skemaF4 = indexSkemaEntries(skemaF4Pages);
  const skemaF5 = indexSkemaEntries(skemaF5Pages);

  console.log(`Buku Selekoh questions extracted: ${bukuQuestions.length}`);

  const matched: MatchedChunk[] = [];
  const questionOnly: MatchedChunk[] = [];
  let matchedCount = 0;

  for (const item of bukuQuestions) {
    const normalized = normalizeTopic(item.topic_en);
    const isRealHeader = KNOWN_TOPICS.has(normalized);
    const topic = isRealHeader ? normalized : SUBTOPIC_FALLBACK[normalized];
    if (!topic) {
      console.warn(`Unknown topic "${item.topic_en}" (form ${item.form}, bab ${item.bab_number}) — skipping question ${item.question.question_no}`);
      continue;
    }
    // When the topic came from SUBTOPIC_FALLBACK, the OCR misread a subsection
    // heading as the chapter banner, which means bab_number is unreliable too —
    // never trust it for Skema lookup, since a coincidental (bab, question_no)
    // match would silently attach the WRONG answer letter to this question.
    const key = `${item.bab_number}:${item.question.question_no}`;
    const answer = isRealHeader ? (item.form === 4 ? skemaF4.get(key) : skemaF5.get(key)) : undefined;
    const source = item.question.source_exam;

    // The answer letter is only meaningful if the transcribed question actually
    // carries its options. It often doesn't: this bank's options are frequently
    // laid out as a diagram or a table that OCR renders as prose, so the letters
    // never reach question_text and the chunk stores a naked "Answer: B" against
    // a question with nothing to map B onto. Measured on what this script had
    // already written: 86 of 430 stored Physics chunks were in that state, 20 of
    // them with no question sentence left at all. A letter the student cannot
    // resolve is worse than no answer — it reads as authoritative and cannot be
    // checked — so those fall through to question-only instead.
    if (answer && looksLikeMcq(item.question.question_text)) {
      matchedCount++;
      matched.push({
        topic,
        subtopic: `Form ${item.form}`,
        content: sanitize(`${item.question.question_text}\n\nAnswer: ${answer}`),
        source: source ? sanitize(source) : null,
      });
    } else {
      if (answer) {
        console.warn(
          `Q${item.question.question_no} (${source ?? "unknown source"}): key says ${answer} but the transcribed question shows no A-D options — storing the question without the answer.`,
        );
      }
      questionOnly.push({
        topic,
        subtopic: `Form ${item.form}`,
        content: sanitize(item.question.question_text),
        source: source ? sanitize(source) : null,
      });
    }
  }

  console.log(`Matched with answer: ${matchedCount}`);
  console.log(`Question-only (no answer found): ${questionOnly.length}`);

  // The weekly quiz has no answer key at all — every question goes in question-only,
  // topic assigned per-question by the OCR model's best guess.
  const quizChunks: MatchedChunk[] = [];
  for (const page of quizPages) {
    for (const q of page?.questions ?? []) {
      const topic = normalizeTopic(q.topic_guess ?? "");
      if (!KNOWN_TOPICS.has(topic)) {
        console.warn(`Quiz question ${q.question_no}: unrecognized topic guess "${q.topic_guess}" — skipping`);
        continue;
      }
      quizChunks.push({
        topic,
        subtopic: "Form 5",
        content: sanitize(q.question_text),
        source: "Kuiz Mingguan 2026 (KM: 1)",
      });
    }
  }
  console.log(`Quiz questions (question-only): ${quizChunks.length}`);

  const allChunks = [...matched, ...questionOnly, ...quizChunks];

  const dryRun = process.argv.includes("--dry-run");
  if (dryRun) {
    await writeFile(`${CACHE_DIR}/matched-preview.json`, JSON.stringify(matched.slice(0, 10), null, 2), "utf-8");
    await writeFile(`${CACHE_DIR}/question-only-preview.json`, JSON.stringify(questionOnly.slice(0, 10), null, 2), "utf-8");
    await writeFile(`${CACHE_DIR}/quiz-preview.json`, JSON.stringify(quizChunks.slice(0, 10), null, 2), "utf-8");
    console.log(`Dry run — wrote preview files to ${CACHE_DIR}. No DB writes.`);
    return;
  }

  console.log(`Embedding and inserting ${allChunks.length} chunks...`);
  for (const [i, chunk] of allChunks.entries()) {
    const embedding = await embedPassage(chunk.content);
    const { error } = await supabase.from("content_chunks").insert({
      exam_board: "SPM",
      subject: "Physics",
      topic: chunk.topic,
      subtopic: chunk.subtopic,
      content_type: "past_year_question",
      difficulty: "medium",
      content: chunk.content,
      source: chunk.source,
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
