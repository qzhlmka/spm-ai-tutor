/**
 * Which language the tutor must reply in, decided in code rather than left to
 * each model to infer.
 *
 * WHY THIS EXISTS. TUTOR_SYSTEM_PROMPT already carries a strong LANGUAGE rule
 * ("reply in the student's language … never code-switch mid-reply"), and Claude
 * and GPT obey it. IlmuChat does not reliably. Measured over 12 identical turns
 * per provider (two English and two Malay questions, three runs each, through
 * the real handleChatRequest):
 *
 *   anthropic  0/12 wrong language
 *   openai     0/12
 *   ilmuchat   3/12 — one reply that opened in Malay and continued in
 *              Traditional Chinese ("Baik, kita akan belajar tentang Teknik-U.
 *              這是一個在化學中解決涉及摩爾概念問題的系統化方法…"), and two that
 *              opened in English and switched to Malay from the first step
 *              heading onward.
 *
 * All three were answers to ENGLISH questions, which is the tell: an inferred
 * rule loses to the pull of the Malay teacher material in the context block.
 * Stating the answer ("Reply in English.") on every turn removes the inference.
 * It is the same move the prompt already makes for the asker's role, and for
 * the same reason — a model should not have to deduce what code already knows.
 *
 * Returns null when the question doesn't settle it ("hi testing", "past years
 * topic on consumer mathematics"). Null means "add no directive", so the
 * prompt's own rule — which also considers the student's previous messages —
 * still applies. Forcing a language on an ambiguous question is the one way
 * this could make replies worse, so it never guesses.
 */

export type ReplyLanguage = "english" | "malay";

/** Explicit requests to switch, checked BEFORE word counting. "in malay"
 * counts as English by vocabulary (the word "in"), which is exactly backwards. */
const EXPLICIT_SWITCH: [RegExp, ReplyLanguage][] = [
  [/\b(in|into|use|using|guna|dalam)\s+(english|bahasa inggeris|b\.?\s?inggeris|bi)\b/i, "english"],
  [/\b(in|into|use|using|guna|dalam)\s+(malay|bahasa melayu|b\.?\s?melayu|bm|melayu)\b/i, "malay"],
  [/\bbahasa melayu\b/i, "malay"],
  [/\bbahasa inggeris\b/i, "english"],
];

/** Function words and instruction verbs. Deliberately NOT subject terms:
 * "Teknik-U", "past year" and formula names appear in both languages' questions
 * and would bias the count toward whichever language the curriculum used. */
const MALAY_WORDS = new Set(
  (
    "ialah adalah untuk dengan yang ini itu dalam boleh kita saya anda awak bagi daripada juga " +
    "kerana jika maka iaitu langkah cara apa apakah bagaimana macam mana kenapa mengapa terangkan " +
    "huraikan nyatakan tentukan hitung kira cari selesaikan tolong ajar nak tak ke ni tu je ada " +
    "tiada soalan jawapan contoh nota kaedah rumus"
  ).split(" "),
);
const ENGLISH_WORDS = new Set(
  (
    "the is are and for with this that you your can we of to in how what which why because if then " +
    "explain teach me show find calculate solve give example question answer notes method formula " +
    "please do does"
  ).split(" "),
);

export function studentLanguage(question: string): ReplyLanguage | null {
  if (!question) return null;
  for (const [re, lang] of EXPLICIT_SWITCH) if (re.test(question)) return lang;

  let malay = 0;
  let english = 0;
  for (const token of question.toLowerCase().match(/[a-z]+/g) ?? []) {
    if (MALAY_WORDS.has(token)) malay++;
    if (ENGLISH_WORDS.has(token)) english++;
  }
  // A 2:1 margin, not a simple majority. Malaysian students mix freely ("boleh
  // bagi contoh past years tak nak practice"), and a near-tie is exactly the
  // case where the prompt's own history-aware rule should decide.
  if (malay > 0 && malay >= 2 * english) return "malay";
  if (english > 0 && english >= 2 * malay) return "english";
  return null;
}

/** The per-turn directive, placed beside the asker line in the user message. */
export function replyLanguageDirective(lang: ReplyLanguage | null): string {
  if (lang === "english") {
    return "\n\nReply language: ENGLISH. Write the entire reply in English, including headings and step labels, even where the background knowledge is in Malay — translate what you use.";
  }
  if (lang === "malay") {
    return "\n\nReply language: BAHASA MELAYU. Write the entire reply in Bahasa Melayu, including headings and step labels, even where the background knowledge is in English — translate what you use.";
  }
  return "";
}

/** Chinese/Japanese script. Never a valid reply language here — the tutor
 * serves English and Malay SPM content only — so unlike Malay/English mixing,
 * which a heuristic cannot judge safely (formulas, quoted source terms), its
 * presence is an unambiguous failure that code can act on. */
export function containsCjk(text: string): boolean {
  return /[぀-ヿ㐀-䶿一-鿿]/.test(text);
}
