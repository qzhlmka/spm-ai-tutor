/**
 * Rewrites the Malay terms in a student's question into their English
 * equivalents, so a Malay question can reach English-language chunks.
 *
 * THE PROBLEM THIS SOLVES. The knowledge base is language-partitioned by
 * subject: Add Maths, Mathematics and Physics were ingested from English
 * textbooks, while most Chemistry teacher material and all of Sejarah is Malay.
 * multilingual-e5 is cross-lingual in principle, but measured on the real KB
 * same-language text wins decisively, so a Malay question cannot reach the
 * English half:
 *
 *   query             expected      Malay hits   English hits  (top 6)
 *   "pembezaan"       Add Maths        0/6          6/6
 *   "kamiran"         Add Maths        2/6          6/6
 *   "hukum linear"    Add Maths        2/6          6/6
 *   "keelektrikan"    Physics          0/6          6/6
 *
 * And it does not merely miss. "pembezaan" returns six CHEMISTRY chunks (about
 * balancing combustion equations and dilution), because Malay queries gravitate
 * to the Malay-heavy part of the corpus. The tutor is strictly grounded, so it
 * then correctly refuses a question it holds 116 chunks on — which surfaces as
 * a tutor that seems oddly useless in Malay rather than as a visibly wrong
 * answer. Real report: "Terangkan cara membezakan fungsi dalam Add Maths
 * langkah demi langkah" was answered "Saya belum ada nota yang menerangkan
 * kaedah pembezaan".
 *
 * The successes above are the tell: logaritma, janjang, tekanan and "daya dan
 * gerakan" all score 6/6 because they are cognates or appear verbatim in the
 * corpus. The failures are Malay words with no surface anchor in English text.
 *
 * WHY A GLOSSARY RATHER THAN RE-EMBEDDING. The thorough fix is a bilingual
 * anchor in passageTextForChunk() plus a full re-embed, giving every English
 * chunk a Malay handle. That rewrites what all ~10.7k chunks embed and so moves
 * EVERY similarity score in the system, invalidating TEACHER_MATERIAL_MIN_
 * SIMILARITY (0.75), the 0.83 judge fallback and the lexical IDF floor — all
 * empirically tuned, and at least one already drifting. A glossary changes only
 * the query side, adds no model call, costs one extra embedding, and leaves
 * every tuned constant untouched. It is the reversible half of the fix.
 *
 * WHY SUBSTITUTION, NOT APPENDING. Appending ("pembezaan differentiation")
 * keeps the Malay tokens in the embedding and measured worse than replacing
 * them, because the Malay tokens are exactly what pulls the vector toward the
 * Malay-heavy corpus. The rewritten query is run as its OWN lane beside the
 * original, so nothing is lost when the rewrite is wrong — the original still
 * retrieves whatever it would have.
 *
 * SCOPE. Deliberately not a translator. It covers SPM topic vocabulary and the
 * handful of instruction verbs that open a Malay exam question, which is a
 * closed set that can be checked by eye. A word it does not know is left alone.
 */

/** Malay -> English. Keys are matched longest-first on word boundaries, so a
 * multi-word term wins over its parts ("hukum linear" before "linear", "daya
 * dan gerakan" before "daya"). Values are the English wording the corpus
 * actually uses — taken from the `topic` column, not from a dictionary, since
 * the point is to land on text that exists. */
const GLOSSARY: Record<string, string> = {
  // --- Add Maths topics -----------------------------------------------------
  pembezaan: "differentiation",
  membezakan: "differentiate",
  kamiran: "integration",
  mengamirkan: "integrate",
  "geometri koordinat": "coordinate geometry",
  "fungsi trigonometri": "trigonometric functions",
  trigonometri: "trigonometry",
  "taburan kebarangkalian": "probability distribution",
  kebarangkalian: "probability",
  "indeks, surd dan logaritma": "indices surds and logarithms",
  logaritma: "logarithm",
  surd: "surds",
  indeks: "indices",
  "pilih atur dan gabungan": "permutation and combination",
  "pilih atur": "permutation",
  gabungan: "combination",
  "fungsi kuadratik": "quadratic functions",
  kuadratik: "quadratic",
  fungsi: "function",
  janjang: "progressions",
  "kinematik gerakan linear": "kinematics of linear motion",
  kinematik: "kinematics",
  "sistem persamaan": "systems of equations",
  persamaan: "equation",
  "sukatan membulat": "circular measure",
  "hukum linear": "linear law",
  vektor: "vectors",
  "pengaturcaraan linear": "linear programming",
  "penyelesaian segi tiga": "solution of triangles",
  "nombor indeks": "index numbers",

  // --- Mathematics topics ---------------------------------------------------
  "penaakulan logik": "logical reasoning",
  matriks: "matrices",
  "kekongruenan, pembesaran dan gabungan penjelmaan":
    "congruency enlargement and combined transformations",
  penjelmaan: "transformations",
  ubahan: "variation",
  "matematik pengguna": "consumer mathematics",
  percukaian: "taxation",
  insurans: "insurance",
  "ketaksamaan linear": "linear inequalities",
  ketaksamaan: "inequalities",
  "operasi ke atas set": "operations on sets",
  set: "sets",
  "sukatan serakan": "measures of dispersion",
  serakan: "dispersion",
  "asas nombor": "number bases",
  "rangkaian dalam teori graf": "network in graph theory",
  "teori graf": "graph theory",
  "nisbah dan graf fungsi trigonometri":
    "ratios and graphs of trigonometric functions",
  nisbah: "ratio",
  "graf gerakan": "graphs of motion",
  "pemodelan matematik": "mathematical modeling",

  // --- Physics topics -------------------------------------------------------
  "daya dan gerakan": "force and motion",
  "cahaya dan optik": "light and optics",
  optik: "optics",
  gelombang: "waves",
  tekanan: "pressure",
  haba: "heat",
  keelektrikan: "electricity",
  elektrik: "electricity",
  "fizik kuantum": "quantum physics",
  kuantum: "quantum",
  kegravitian: "gravitation",
  graviti: "gravitation",
  "fizik nuklear": "nuclear physics",
  nuklear: "nuclear",
  keelektromagnetan: "electromagnetism",
  elektromagnet: "electromagnetism",
  elektronik: "electronics",
  pengukuran: "measurement",

  // --- Chemistry topics -----------------------------------------------------
  "asid, bes dan garam": "acid base and salt",
  // How students type it; with only the comma form, "asid bes dan garam" came
  // out as "acid base dan salt" and matched no topic.
  "asid bes dan garam": "acid base and salt",
  asid: "acid",
  bes: "base",
  garam: "salt",
  "sebatian karbon": "carbon compound",
  "keseimbangan redoks": "redox equilibrium",
  redoks: "redox",
  "konsep mol": "the mole concept",
  mol: "mole",
  "formula kimia": "chemical formula",
  termokimia: "thermochemistry",
  "jadual berkala unsur": "the periodic table of elements",
  "jadual berkala": "periodic table",
  unsur: "elements",
  "kadar tindak balas": "rate of reaction",
  "tindak balas": "reaction",
  "ikatan kimia": "chemical bond",
  polimer: "polymer",
  "pengguna kimia": "chemical consumer",
  "jirim dan struktur atom": "matter and the atomic structure",
  jirim: "matter",
  atom: "atom",
  "bahan buatan dalam industri": "manufactured substances in industry",

  // --- Instruction verbs and common nouns -----------------------------------
  terangkan: "explain",
  huraikan: "describe",
  nyatakan: "state",
  tentukan: "determine",
  hitung: "calculate",
  kira: "calculate",
  cari: "find",
  selesaikan: "solve",
  lukis: "draw",
  lakar: "sketch",
  bandingkan: "compare",
  takrifkan: "define",
  "apakah maksud": "what is the meaning of",
  "apa itu": "what is",
  "bagaimana": "how",
  contoh: "example",
  "langkah demi langkah": "step by step",
  langkah: "step",
  kaedah: "method",
  rumus: "formula",
  graf: "graph",
  rajah: "diagram",
  jadual: "table",
  sudut: "angle",
  "segi tiga": "triangle",
  bulatan: "circle",
  jejari: "radius",
  luas: "area",
  isipadu: "volume",
  halaju: "velocity",
  laju: "speed",
  pecutan: "acceleration",
  daya: "force",
  tenaga: "energy",
  jisim: "mass",
  ketumpatan: "density",
  suhu: "temperature",
  cahaya: "light",
  bunyi: "sound",
  litar: "circuit",
  arus: "current",
  voltan: "voltage",
  rintangan: "resistance",
  gerakan: "motion",
  pergerakan: "motion",
  kelajuan: "speed",
  pemalar: "constant",
  pembolehubah: "variable",
  penyelesaian: "solution",
  jawapan: "answer",
  soalan: "question",
  nota: "notes",
};

const KEYS = Object.keys(GLOSSARY).sort((a, b) => b.length - a.length);

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Returns the question with its known Malay terms replaced by English, or null
 * when nothing matched — null means "don't run the extra lane", so an English
 * question costs nothing.
 *
 * Case-insensitive, word-boundary matched, longest key first. Boundaries are
 * `[^a-z]` rather than \b because Malay terms here are plain ASCII and \b would
 * also fire inside hyphenated compounds.
 */
export function rewriteMalayTerms(question: string): string | null {
  if (!question) return null;
  let out = question;
  let changed = false;
  for (const key of KEYS) {
    const re = new RegExp(String.raw`(^|[^a-zA-Z])${escapeRegex(key)}([^a-zA-Z]|$)`, "gi");
    if (!re.test(out)) continue;
    re.lastIndex = 0;
    out = out.replace(re, (_m, before: string, after: string) => `${before}${GLOSSARY[key]}${after}`);
    changed = true;
  }
  return changed ? out : null;
}
