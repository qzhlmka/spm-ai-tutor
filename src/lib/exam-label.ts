/**
 * Turns a past-year chunk's free-text `source` label into structured fields, so
 * a question can be found by "Johor 2023" instead of only by what it is about.
 *
 * WHY THIS IS A PARSER AND NOT A COLUMN: nothing upstream ever recorded the
 * exam a question came from. `source` is whatever the chunking model copied off
 * the page, and the page itself was vision-OCR'd, so the label arrives as prose
 * in five different per-subject shapes:
 *
 *   Add Maths    TRIAL SELANGOR 2022 2022 (Soalan 10)    <- year printed twice
 *   Chemistry    TRIAL PAHANG JUC SET 2 2023 – (S8)
 *   Mathematics  PERUBAAAN NEGERI JOHOR (KULAI) 2023 (NO 23)
 *   Physics      PERAK 2023 (6)                          <- no exam-type word
 *   Sejarah      Percubaan Selangor Set 2 2021, Soalan 2(a)
 *
 * and the OCR mangles the one word that identifies them. "Percubaan" (trial) is
 * stored six ways across Mathematics alone — PERUBAHAN (180), PERCUBAAN (177),
 * PERUBAAAN (16), PERUBCAAN (7), PERCAUBAN (6), PERUBAN (6). That matters more
 * than it looks: "Perubahan" is an ordinary Malay word meaning "change", so the
 * most common spelling of the label is not a typo any speller would flag, and a
 * keyword search for the correct spelling silently misses half the rows.
 *
 * So the exam-type word is deliberately NOT used to decide anything. The parse
 * keys on the two things OCR gets right because they are short and distinctive:
 * a four-digit year, and a place name matched against a closed list.
 */

/** Canonical authority for every spelling we have seen, lowercased keys.
 * Districts map to their state so that "Johor" finds Kluang and Batu Pahat
 * papers too — a student asking for Johor does not mean "only the paper that
 * happened to be labelled with no district". */
const AUTHORITY_ALIASES: Record<string, { authority: string; district?: string }> = {
  // States
  johor: { authority: "Johor" },
  kedah: { authority: "Kedah" },
  kelantan: { authority: "Kelantan" },
  melaka: { authority: "Melaka" },
  malacca: { authority: "Melaka" },
  "negeri sembilan": { authority: "Negeri Sembilan" },
  "n. sembilan": { authority: "Negeri Sembilan" },
  "n sembilan": { authority: "Negeri Sembilan" },
  pahang: { authority: "Pahang" },
  perak: { authority: "Perak" },
  perlis: { authority: "Perlis" },
  "pulau pinang": { authority: "Pulau Pinang" },
  penang: { authority: "Pulau Pinang" },
  sabah: { authority: "Sabah" },
  sarawak: { authority: "Sarawak" },
  selangor: { authority: "Selangor" },
  terengganu: { authority: "Terengganu" },
  // Federal territories
  "kuala lumpur": { authority: "Kuala Lumpur" },
  labuan: { authority: "Labuan" },
  putrajaya: { authority: "Putrajaya" },
  // Johor districts — each sets the state AND keeps the district
  kluang: { authority: "Johor", district: "Kluang" },
  "batu pahat": { authority: "Johor", district: "Batu Pahat" },
  "bt pahat": { authority: "Johor", district: "Batu Pahat" },
  pontian: { authority: "Johor", district: "Pontian" },
  kulai: { authority: "Johor", district: "Kulai" },
  tangkak: { authority: "Johor", district: "Tangkak" },
  "johor bahru": { authority: "Johor", district: "Johor Bahru" },
  "johor baharu": { authority: "Johor", district: "Johor Bahru" },
  muar: { authority: "Johor", district: "Muar" },
  segamat: { authority: "Johor", district: "Segamat" },
  skudai: { authority: "Johor", district: "Skudai" },
  // National bodies that set their own trial papers
  mrsm: { authority: "MRSM" },
  mrsn: { authority: "MRSM" }, // OCR slip: no such body, always MRSM on inspection
  sbp: { authority: "SBP" },
  smka: { authority: "SMKA/SABK" },
  sabk: { authority: "SMKA/SABK" },
  "smka/sabk": { authority: "SMKA/SABK" },
  "smka & sabk": { authority: "SMKA/SABK" },
  // OCR variants of SMKA/SABK. Kept as explicit aliases rather than a fuzzy
  // match because the correct string contains a slash and the transcriptions
  // move it around ("SMK/ASBK", "SMK/SA/ABK") — a fuzzy rule loose enough to
  // catch those also catches the bare "SMK", which is every ordinary school.
  "smk/asbk": { authority: "SMKA/SABK" },
  "smk/sa/abk": { authority: "SMKA/SABK" },
  smika: { authority: "SMKA/SABK" },
  juc: { authority: "Pahang", district: "JUC" },
  // Johor's own trial board. All four spellings are the same three letters
  // transposed by OCR; no other body in this corpus is a J-U permutation.
  juj: { authority: "Johor", district: "JUJ" },
  jui: { authority: "Johor", district: "JUJ" },
  jiu: { authority: "Johor", district: "JUJ" },
  jju: { authority: "Johor", district: "JUJ" },
  // Yayasan Islam Kelantan sets its own paper, so it is its own authority
  // rather than folded into Kelantan's state trial.
  yik: { authority: "YIK" },
  // Districts seen only once each
  "kota tinggi": { authority: "Johor", district: "Kota Tinggi" },
  semporna: { authority: "Sabah", district: "Semporna" },
};

/** Escapes every regex metacharacter. The alias list contains "." ("n. sembilan")
 * and "/" ("smk/asbk"); an unescaped "." would match any character and let
 * "n sembilan" style noise through. */
function escapeRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\//g, "\\/");
}

/** Longest-first so "negeri sembilan" is tried before "sembilan"-like
 * fragments, and "johor bahru" before the bare "johor" that it contains. */
const AUTHORITY_KEYS = Object.keys(AUTHORITY_ALIASES).sort((a, b) => b.length - a.length);

export interface ExamLabel {
  year: number | null;
  /** Canonical state or examining body, e.g. "Johor", "MRSM", "SPM". */
  authority: string | null;
  /** Sub-area within the authority, e.g. "Kluang". Null when the label had none. */
  district: string | null;
  /** "Set 1"/"Set 2" papers — the same authority and year can publish both. */
  set: number | null;
  /** The printed question number. Kept as text: labels carry "S8" and "2(a)"
   * as well as plain integers, and forcing those into an integer is how the
   * answer-key pairing went wrong in the first place. */
  questionNo: string | null;
}

export const EMPTY_EXAM_LABEL: ExamLabel = {
  year: null,
  authority: null,
  district: null,
  set: null,
  questionNo: null,
};

/** SPM years that can plausibly appear. An upper bound of "next year" rejects
 * OCR noise like a 4-digit figure lifted out of the question body (a Sejarah
 * question about 1957, a Physics value of 6370). */
const EARLIEST_SPM_YEAR = 2000;

export function parseExamLabel(source: string | null | undefined, now = new Date()): ExamLabel {
  if (!source) return { ...EMPTY_EXAM_LABEL };
  const raw = String(source);
  const haystack = raw.toLowerCase();
  const maxYear = now.getFullYear() + 1;

  // Year. Several labels print it twice ("TRIAL SELANGOR 2022 2022"); any match
  // is equally good, so take the first in range.
  let year: number | null = null;
  for (const m of raw.matchAll(/\b(20\d{2})\b/g)) {
    const y = Number(m[1]);
    if (y >= EARLIEST_SPM_YEAR && y <= maxYear) {
      year = y;
      break;
    }
  }

  // Authority. Word-boundary matched so "perak" cannot be found inside another
  // word; longest alias first so districts beat their own state name.
  let authority: string | null = null;
  let district: string | null = null;
  for (const key of AUTHORITY_KEYS) {
    if (new RegExp(String.raw`(^|[^a-z])${escapeRegex(key)}([^a-z]|$)`).test(haystack)) {
      const hit = AUTHORITY_ALIASES[key];
      // A district match wins outright. Otherwise the first (longest) state
      // match wins, and we keep scanning only to upgrade a bare state to a
      // district of that same state.
      if (hit.district) {
        authority = hit.authority;
        district = hit.district;
        break;
      }
      if (!authority) authority = hit.authority;
    }
  }
  // "SPM 2022 (SEPTEMBER)" / "SPM BAHAGIAN A 2022" — the real paper, not a
  // state trial. Only when no state was named, since state trials also print
  // the word SPM ("BUKU SELEKOH AKHIR SPM 2024").
  if (!authority && /(^|[^a-z])spm([^a-z]|$)/.test(haystack)) authority = "SPM";

  const setMatch = haystack.match(/\bset\s*(\d)/);
  const set = setMatch ? Number(setMatch[1]) : null;

  // Question number: an explicit marker first ("No 12", "Soalan 5", "Q9"),
  // falling back to a trailing parenthesised token ("(6)", "(S8)", "(08)").
  // Anchored to the END so a bracketed district — "JOHOR (KULAI) 2023" — is
  // never mistaken for a question number.
  let questionNo: string | null = null;
  const marked = raw.match(/\b(?:no|soalan|question|q)\s*\.?\s*[:\-]?\s*([0-9]{1,3}\s*(?:\([a-z]\))?)/i);
  if (marked) {
    questionNo = marked[1].replace(/\s+/g, "");
  } else {
    const trailing = raw.match(/\(\s*([A-Za-z]?[0-9]{1,3}(?:\([a-z]\))?)\s*\)\s*$/);
    if (trailing) questionNo = trailing[1];
  }

  return { year, authority, district, set, questionNo };
}

/** What a student's own question is asking to be filtered by.
 *
 * Separate from parseExamLabel() on purpose: that reads a label the pipeline
 * wrote, this reads free-form text a teenager typed, in either language, and
 * the two fail in different directions. A label with no year is a parse gap; a
 * QUESTION with no year is just an ordinary question and must stay on the
 * normal retrieval path. */
/** The topics (from `topics`, the subject's own list) that a question names,
 * in its own words or in the English rewrite of its Malay terms
 * ("gelombang" -> waves). A whole-phrase match on the normalised name; a
 * trailing "I"/"II" may be left off ("daya dan gerakan" names both Force and
 * Motion I and II). Used to order an exam paper's questions, never to filter
 * which papers match. */
export function topicsNamedIn(question: string, englishRewrite: string | null, topics: string[]): string[] {
  const norm = (s: string) => ` ${s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim()} `;
  const text = norm(`${question} ${englishRewrite ?? ""}`);
  return topics.filter((t) => {
    const name = norm(t.replace(/^the /i, ""));
    const base = name.replace(/ (i|ii) $/, " ");
    return text.includes(name) || (base !== name && text.includes(base));
  });
}

export interface ExamFilter {
  year: number | null;
  authority: string | null;
  district: string | null;
  /** Canonical subject, when the student named one. Null means "any subject" —
   * the tutor then gets a mixed set and narrows it itself. */
  subject: string | null;
}

/** Subject names as students write them, in both languages. Longest-first at
 * match time, because "matematik tambahan" contains "matematik" and the two are
 * different subjects with different papers. */
const SUBJECT_ALIASES: Record<string, string> = {
  "additional mathematics": "Add Maths",
  "matematik tambahan": "Add Maths",
  "add maths": "Add Maths",
  "add math": "Add Maths",
  addmaths: "Add Maths",
  addmath: "Add Maths",
  mathematics: "Mathematics",
  matematik: "Mathematics",
  maths: "Mathematics",
  math: "Mathematics",
  physics: "Physics",
  fizik: "Physics",
  chemistry: "Chemistry",
  kimia: "Chemistry",
  sejarah: "Sejarah",
  history: "Sejarah",
};
const SUBJECT_KEYS = Object.keys(SUBJECT_ALIASES).sort((a, b) => b.length - a.length);

/** Phrases that mean "I want an exam paper", as opposed to merely mentioning a
 * place or a number.
 *
 * Requiring one of these is the guard that makes this feature safe, and it is
 * not optional. Every Malaysian state name is also ordinary subject matter:
 * "terangkan sejarah Perak" names Perak, and filtering that turn down to Perak's
 * trial paper would replace a history lesson with a list of exam questions. The
 * bare word "spm" is deliberately NOT here either — students append it to
 * everything ("explain this for SPM"), so it carries no filtering intent. */
const PAST_YEAR_INTENT_STRONG = [
  "past year",
  "past-year",
  "pastyear",
  "past paper",
  "past papers",
  "previous year",
  "trial paper",
  "kertas soalan",
  "kertas percubaan",
  "soalan percubaan",
  "soalan spm",
  "latih tubi",
  "tahun lepas",
  "exam paper",
  "exam question",
  "soalan peperiksaan",
];

/** Intent words that are ordinary vocabulary on their own, so they are NOT
 * enough to filter on a subject alone — they still require a year or a place.
 *
 * "trial" is an ordinary English word ("let's trial this method") and
 * "percubaan" is ordinary Malay for "attempt". While a year or place was also
 * required these were harmless, because no one writes "trial Johor 2023" by
 * accident. Allowing a subject to stand in for that second signal removes the
 * accident guard, so "let's trial this math problem" would filter the turn down
 * to Mathematics exam questions. Keeping them out of the strong list preserves
 * the old behaviour for exactly the phrasings that were only ever safe because
 * of it. The longer forms that contain them ("trial paper", "soalan percubaan")
 * are unambiguous and live in the strong list above. */
const PAST_YEAR_INTENT_WEAK = ["trial", "percubaan"];

/** Whether a question unambiguously asks for past-year material, regardless of
 * whether it names a year, a place or a subject. chat-handler.ts uses this for
 * the case this module cannot resolve on its own: a past-year request whose
 * subject is only knowable from the conversation so far. */
export function hasStrongPastYearIntent(question: string): boolean {
  if (!question) return false;
  const haystack = question.toLowerCase();
  return PAST_YEAR_INTENT_STRONG.some((phrase) => haystack.includes(phrase));
}

/** Aliases that are ordinary English words as well as subject names. Safe in
 * parseSubject(), which only runs behind a past-year intent phrase, but not in
 * subjectsNamedIn(), which runs on every question: "explain the history of the
 * periodic table" is a Chemistry question, and reading "history" as Sejarah
 * there would strip the student's Chemistry notes from the answer. */
const AMBIGUOUS_SUBJECT_ALIASES = new Set(["history"]);

/** Every canonical subject a question names outright, for the teacher-material
 * subject guard in chat-handler.ts.
 *
 * Returns a list rather than the first hit because the guard must stand down
 * when a question spans subjects ("how is maths used in chemistry"). Matched
 * spans are blanked as they are consumed, longest alias first, so "add maths"
 * yields Add Maths alone rather than Add Maths plus Mathematics from the
 * "maths" inside it. */
export function subjectsNamedIn(text: string | null | undefined): string[] {
  if (!text) return [];
  let haystack = text.toLowerCase();
  const found = new Set<string>();
  for (const key of SUBJECT_KEYS) {
    if (AMBIGUOUS_SUBJECT_ALIASES.has(key)) continue;
    const re = new RegExp(String.raw`(^|[^a-z])${escapeRegex(key)}([^a-z]|$)`, "g");
    if (!re.test(haystack)) continue;
    found.add(SUBJECT_ALIASES[key]);
    re.lastIndex = 0;
    haystack = haystack.replace(re, (_m, before: string, after: string) => `${before}${" ".repeat(key.length)}${after}`);
  }
  return [...found];
}

/** The canonical subject named in a piece of free text, or null. Exported so
 * chat-handler.ts can read a subject out of the conversation history using the
 * same alias table and the same word-boundary rules as the question itself. */
export function parseSubject(text: string | null | undefined): string | null {
  if (!text) return null;
  const haystack = text.toLowerCase();
  for (const key of SUBJECT_KEYS) {
    if (new RegExp(String.raw`(^|[^a-z])${escapeRegex(key)}([^a-z]|$)`).test(haystack)) {
      return SUBJECT_ALIASES[key];
    }
  }
  return null;
}

export function parseExamFilterFromQuestion(question: string, now = new Date()): ExamFilter | null {
  if (!question) return null;
  const haystack = question.toLowerCase();
  const maxYear = now.getFullYear() + 1;

  // Intent gate first — cheapest, and it rejects the dangerous majority.
  const hasStrongIntent = PAST_YEAR_INTENT_STRONG.some((phrase) => haystack.includes(phrase));
  if (!hasStrongIntent && !PAST_YEAR_INTENT_WEAK.some((phrase) => haystack.includes(phrase))) return null;

  let year: number | null = null;
  for (const m of question.matchAll(/\b(20\d{2})\b/g)) {
    const y = Number(m[1]);
    if (y >= EARLIEST_SPM_YEAR && y <= maxYear) {
      year = y;
      break;
    }
  }

  let authority: string | null = null;
  let district: string | null = null;
  for (const key of AUTHORITY_KEYS) {
    if (new RegExp(String.raw`(^|[^a-z])${escapeRegex(key)}([^a-z]|$)`).test(haystack)) {
      const hit = AUTHORITY_ALIASES[key];
      if (hit.district) {
        authority = hit.authority;
        district = hit.district;
        break;
      }
      if (!authority) authority = hit.authority;
    }
  }

  let subject: string | null = null;
  for (const key of SUBJECT_KEYS) {
    if (new RegExp(String.raw`(^|[^a-z])${escapeRegex(key)}([^a-z]|$)`).test(haystack)) {
      subject = SUBJECT_ALIASES[key];
      break;
    }
  }

  // A year, a place, OR a subject makes this a filtered request.
  //
  // Subject was NOT originally accepted here, on the reasoning that "give me a
  // past year question on matrices" is an ordinary retrieval the normal lanes
  // answer well. Measurement disproved that, and in both directions at once.
  // The past-year prefix that passageTextForChunk() adds is a strong retrieval
  // signal that carries no subject, so one cosine query cannot serve
  // "past-year-ness" and "chemistry-ness" at the same time — whichever
  // dominates the embedding wins outright. Measured on the real KB:
  //
  //   "contoh past year"                    -> 8/8 Sejarah, in a Chemistry chat
  //   "boleh bagi contoh past years..."     -> 6 Sejarah, 2 Add Maths
  //   "can you help me with chemistry past years" -> 0 past-year chunks at all,
  //       only Chemistry concept chunks, so the tutor replied that it had no
  //       Chemistry past-year questions saved. It has 454.
  //
  // Naming the subject lost the questions; omitting it lost the subject. A
  // predicate is the only thing that answers both, which is what this lane is.
  // Sejarah wins the subject-less case on LANGUAGE rather than volume (753
  // chunks vs Chemistry's 454): it is Malay prose, these queries are Malay, and
  // e5 is multilingual, while the other subjects' questions are formula- and
  // diagram-heavy.
  //
  // Only a STRONG intent phrase may be paired with a bare subject — see
  // PAST_YEAR_INTENT_WEAK for why "trial" cannot.
  if (year === null && authority === null && !(hasStrongIntent && subject !== null)) return null;
  return { year, authority, district, subject };
}
