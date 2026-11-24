/**
 * What the knowledge base actually holds — subjects, their topics, how many
 * past-year questions, how many teacher uploads — read from the database, for
 * "what do you have" questions.
 *
 * WHY THIS EXISTS. Retrieval cannot answer a catalogue question. "do you have
 * any add maths resources" has no topic to search on, so the lanes return a
 * mixed handful (measured: 6 Add Maths chunks out of 12, the rest Chemistry and
 * Mathematics), and the tutor then counted what it happened to see. Graded on
 * real turns: it told a teacher there were "six" Add Maths topics, one of them
 * "Limits", when the knowledge base holds all 18 and Limits is not an SPM Add
 * Maths chapter. The fix is to stop inferring the catalogue and read it.
 *
 * Cached per process: it changes only when content is ingested or a teacher
 * uploads, and a few minutes' lag on a brand-new upload is harmless here,
 * whereas scanning ~10k rows on every catalogue question is not.
 */
import { supabase } from "./supabase.js";

const TTL_MS = 10 * 60 * 1000;
const PAGE = 1000;

/** Topics that are buckets rather than syllabus chapters, kept out of the list a student sees. */
const NOT_A_TOPIC = new Set(["General"]);

/** Which form each chapter is taught in, by its printed chapter number. Topics
 * are filed by name only, so "what's in Form 5 Add Maths" had nothing to answer
 * from. Each split is printed chapter by chapter in that subject's Selekoh 2026
 * modules ("Bab 2: Pembezaan" in Add Maths F5, "TINGKATAN 4 (BAB 6): ASID BES &
 * GARAM" in Chemistry F4, "F4C3: LOGICAL REASONING" in Mathematics, "TINGKATAN 5
 * BAB 2 : TEKANAN / PRESSURE" in Physics), and the
 * names are the topic column's own. Keyed by number because SPM Mathematics
 * also examines a handful of Form 1-3 chapters (F1C6, F1C8, F1C10...), so the
 * numbers are not a run from 1. Mathematics Form 5 Chapter 8, Physics Form 4
 * Chapter 1 (Measurement) and Chemistry Form 4 Chapter 1 are not in their
 * modules; they are the KSSM textbooks'. Other subjects stay unsplit until a source shows theirs. */
const FORM_CHAPTERS: Record<string, Record<string, Record<number, string>>> = {
  "Add Maths": {
    "Form 4": { 1: "Functions", 2: "Quadratic Functions", 3: "Systems of Equations", 4: "Indices, Surds and Logarithms", 5: "Progressions", 6: "Linear Law", 7: "Coordinate Geometry", 8: "Vectors", 9: "Solution of Triangles", 10: "Index Numbers" },
    "Form 5": { 1: "Circular Measure", 2: "Differentiation", 3: "Integration", 4: "Permutation and Combination", 5: "Probability Distribution", 6: "Trigonometric Functions", 7: "Linear Programming", 8: "Kinematics of Linear Motion" },
  },
  Chemistry: {
    // Chapter 1 is not in the module; it is the Form 4 textbooks' (DLP pp.12-31
    // and the Malay edition's Bab 1), re-filed from "General" on 2026-10-26.
    "Form 4": { 1: "Introduction to Chemistry", 2: "Matter and the Atomic Structure", 3: "The Mole Concept, Chemical Formula and Equation", 4: "The Periodic Table of Elements", 5: "Chemical Bond", 6: "Acid, Base and Salt", 7: "Rate of Reaction", 8: "Manufactured Substances in Industry" },
    // Filed as "Chemical Consumer"; the chapter is Consumer and Industrial Chemistry.
    "Form 5": { 1: "Redox Equilibrium", 2: "Carbon Compound", 3: "Thermochemistry", 4: "Polymer", 5: "Chemical Consumer" },
  },
  Mathematics: {
    "Form 1": { 6: "Linear Equations", 8: "Lines and Angles", 10: "Perimeter and Area" },
    "Form 2": { 1: "Patterns and Sequences", 5: "Circles", 7: "Coordinates" },
    "Form 3": { 3: "Savings and Investments, Credit and Debt", 6: "Angles and Tangents of Circles", 9: "Straight Lines" },
    "Form 4": { 1: "Quadratic Functions and Equations in One Variable", 2: "Number Bases", 3: "Logical Reasoning", 4: "Operations on Sets", 5: "Network in Graph Theory", 6: "Linear Inequalities in Two Variables", 7: "Graphs of Motion", 8: "Measures of Dispersion for Ungrouped Data", 9: "Probability of Combined Events", 10: "Consumer Mathematics: Financial Management" },
    "Form 5": { 1: "Variation", 2: "Matrices", 3: "Consumer Mathematics: Insurance", 4: "Consumer Mathematics: Taxation", 5: "Congruency, Enlargement and Combined Transformations", 6: "Ratios and Graphs of Trigonometric Functions", 7: "Measures of Dispersion for Grouped Data", 8: "Mathematical Modeling" },
  },
  Physics: {
    "Form 4": { 1: "Measurement", 2: "Force and Motion I", 3: "Gravitation", 4: "Heat", 5: "Waves", 6: "Light and Optics" },
    "Form 5": { 1: "Force and Motion II", 2: "Pressure", 3: "Electricity", 4: "Electromagnetism", 5: "Electronics", 6: "Nuclear Physics", 7: "Quantum Physics" },
  },
};

/** Chapters of a subject whose material is filed by form rather than by
 * chapter, so its topics are "Form 4" / "Form 5" and nothing in the data names
 * a chapter. Without this a student asking "what's in Form 4 Sejarah" got the
 * word "Form 4" back. Names as printed in the Selekoh 2026 Sejarah modules,
 * which cover every chapter; a form is listed only while its topic is held. */
const CHAPTERS_OF_FORM: Record<string, Record<string, string[]>> = {
  Sejarah: {
    "Form 4": ["Warisan Negara Bangsa", "Kebangkitan Nasionalisme", "Konflik Dunia dan Pendudukan Jepun di Negara Kita", "Era Peralihan Kuasa British di Negara Kita", "Persekutuan Tanah Melayu 1948", "Ancaman Komunis dan Perisytiharan Darurat", "Usaha ke Arah Kemerdekaan", "Pilihan Raya", "Perlembagaan Persekutuan Tanah Melayu 1957", "Pemasyhuran Kemerdekaan"],
    "Form 5": ["Kedaulatan Negara", "Perlembagaan Persekutuan", "Raja Berperlembagaan dan Demokrasi Berparlimen", "Sistem Persekutuan", "Pembentukan Malaysia", "Cabaran Selepas Pembentukan Malaysia", "Membina Kesejahteraan Negara", "Membina Kemakmuran Negara", "Dasar Luar Malaysia", "Kecemerlangan Malaysia di Persada Dunia"],
  },
};

/** The topic line(s): split by form, chapters numbered, where the split is known. */
function topicLines(subject: string, topics: string[]): string[] {
  const byForm = CHAPTERS_OF_FORM[subject];
  if (byForm) {
    return topics.map((t) =>
      byForm[t] ? `  ${t} chapters (${byForm[t].length}): ${byForm[t].map((c, i) => `Bab ${i + 1} ${c}`).join("; ")}` : `  Topic: ${t}`,
    );
  }
  const forms = FORM_CHAPTERS[subject];
  if (!forms) return [`  Topics (${topics.length}): ${topics.join("; ")}`];
  const lines = Object.entries(forms).flatMap(([form, chapters]) => {
    const held = Object.entries(chapters).flatMap(([n, t]) => (topics.includes(t) ? [`Chapter ${n} ${t}`] : []));
    return held.length > 0 ? [`  ${form} topics (${held.length}): ${held.join("; ")}`] : [];
  });
  const placed = new Set(Object.values(forms).flatMap((chapters) => Object.values(chapters)));
  const other = topics.filter((t) => !placed.has(t));
  if (other.length > 0) lines.push(`  Other topics (${other.length}): ${other.join("; ")}`);
  return lines;
}

interface SubjectEntry {
  topics: string[];
  pastYearQuestions: number;
  teacherFiles: number;
}

let cached: { at: number; text: string; topics: Map<string, string[]> } | null = null;

async function loadCatalogue(): Promise<Map<string, SubjectEntry>> {
  const subjects = new Map<string, { topics: Set<string>; pastYear: number }>();
  // PostgREST caps a response at 1000 rows and .range() cannot raise it, so
  // this must paginate (see --topics-from-db in CLAUDE.md, which hit the cap).
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("content_chunks")
      .select("subject, topic, content_type")
      .order("id")
      .range(from, from + PAGE - 1);
    if (error) throw error;
    for (const row of data ?? []) {
      if (!row.subject) continue;
      const entry = subjects.get(row.subject) ?? { topics: new Set<string>(), pastYear: 0 };
      if (row.topic && !NOT_A_TOPIC.has(row.topic)) entry.topics.add(row.topic);
      if (row.content_type === "past_year_question") entry.pastYear++;
      subjects.set(row.subject, entry);
    }
    if ((data ?? []).length < PAGE) break;
  }

  // Counted as files a student can open, the same filter the Materials tab uses.
  const { data: files, error: filesError } = await supabase
    .from("materials")
    .select("subject")
    .eq("status", "done")
    .not("file_path", "is", null);
  if (filesError) throw filesError;
  const filesBySubject = new Map<string, number>();
  for (const f of files ?? []) filesBySubject.set(f.subject, (filesBySubject.get(f.subject) ?? 0) + 1);

  const out = new Map<string, SubjectEntry>();
  for (const [subject, e] of [...subjects].sort((a, b) => a[0].localeCompare(b[0]))) {
    out.set(subject, {
      topics: [...e.topics].sort((a, b) => a.localeCompare(b)),
      pastYearQuestions: e.pastYear,
      teacherFiles: filesBySubject.get(subject) ?? 0,
    });
  }
  return out;
}

function formatCatalogue(catalogue: Map<string, SubjectEntry>): string {
  // One line per fact, each total labelled as a total: a "topics | 452
  // past-year questions" line was read by IlmuChat as 452 questions PER topic.
  // Semicolons inside the topic list because topic names contain commas
  // ("Acid, Base and Salt").
  const blocks = [...catalogue].map(([subject, e]) => {
    const lines = [
      `${subject}`,
      ...topicLines(subject, e.topics),
      // "Trial (percubaan)" named alongside: nearly all of these are state trial
      // papers, and asked "berapa soalan percubaan kimia", the tutor said it had
      // no trial questions and then gave the same 830 as "past-year" ones.
      `  Past-year and trial (percubaan) exam questions, all ${subject} topics combined: ${e.pastYearQuestions}`,
    ];
    if (e.teacherFiles > 0) lines.push(`  Teacher-uploaded files (open them in the Materials tab): ${e.teacherFiles}`);
    return lines.join("\n");
  });
  // Headed "WHAT YOU HAVE", not "catalogue": a model that leaks the heading
  // into its reply ("based on the catalogue...") then at least says something
  // a student can read without it sounding like the machinery.
  return (
    `\n\nWHAT YOU HAVE — the complete and exact list of study material, for this turn. A subject not listed here ` +
    `has no material at all. A "topic" is how the material is filed; Sejarah is filed by form (Form 4 / Form 5) ` +
    `and its chapters (Bab) are listed under each form. Where topics are listed by form, that is the form the chapter is taught in; for a subject ` +
    `listed without forms, do not say which form a topic belongs to.\n${blocks.join("\n")}`
  );
}

/** The catalogue as a prompt note, or "" if it cannot be read — the tutor then
 * falls back to its usual "name your topic" reply rather than a guessed list. */
export async function catalogueNote(log: Pick<Console, "error" | "warn">): Promise<string> {
  return (await loadCached(log))?.text ?? "";
}

/** A subject's topics, from the same cached read — the exam lane uses it to
 * tell which topic a past-year request names. Empty if the catalogue can't be read. */
export async function subjectTopics(subject: string, log: Pick<Console, "error" | "warn">): Promise<string[]> {
  return (await loadCached(log))?.topics.get(subject) ?? [];
}

async function loadCached(log: Pick<Console, "error" | "warn">) {
  if (cached && Date.now() - cached.at < TTL_MS) return cached;
  try {
    const catalogue = await loadCatalogue();
    cached = { at: Date.now(), text: formatCatalogue(catalogue), topics: new Map([...catalogue].map(([s, e]) => [s, e.topics])) };
    return cached;
  } catch (err) {
    log.error("failed to load the knowledge-base catalogue", err);
    return null;
  }
}
