/**
 * Finds a textbook's front and back matter — the pages that are about the book
 * rather than the subject: cover, Rukun Negara, copyright, contents, "how to use
 * this book" icon guides, answer keys, glossary, references, index, the loan
 * pledge (rag-stack Phase 3, experiment p3-no-frontback).
 *
 * Why: these pages repeat every topic's vocabulary with no teaching attached,
 * so they win cosine search. Measured in the pilot baseline: "Mengapa ais
 * terapung di atas air?" ranked Physics F5 (Malay) p9, the icon guide, first.
 *
 * Decided from what a page SAYS, not where it sits: the Physics F4 PDF is
 * page-scrambled (its glossary and index are pages 1-4, Chapter 1 is at the
 * end) and Sejarah T4 has no front matter at all, so "skip the first N pages"
 * is wrong for both. A heading only counts when it is a whole layout cell
 * ("Index" — not "Index Numbers", an Add Maths chapter; not "jawapan" inside a
 * sentence).
 */

/** A page that is book matter on its own, wherever it sits. */
const MATTER_MARKERS = [
  /RUKUN NEGARA/,
  /BOOK SERIAL NO|BOOK Series NO|NO\.? SIRI BUKU|No\. Siri Buku/i,
  /SAYA BERJANJI/,
  /^(Contents|CONTENTS|KANDUNGAN|Kandungan)\b/,
  /^(Acknowledgements|Penghargaan)$/,
  /^(Activities in this book|Aktiviti dalam buku ini)/,
];

/** A section heading that starts back matter running to the end of the book. */
const BACK_HEADINGS = new Set(["Answers", "Jawapan", "Glossary", "Glosari", "References", "List of References", "Rujukan", "Index", "Indeks"]);

/** The line that opens an answer key whose pages carry no heading (DLP Add Maths F4 p298). */
const ANSWER_KEY_OPENER = /complete answer file|QR code for\s+complete answers|kod QR ini untuk jawapan/i;

/** First chapter/theme opener, which ends the front matter. */
const OPENER = /^(CHAPTER|Chapter|BAB|Bab|THEME|Theme|TEMA|Tema)\b/;

/** A contents page: many lines ending in a page number ("Chapter 6 Linear Law 152").
 * Its "THEME 1 ..." lines must not be read as the first chapter opener. */
function looksLikeContents(page: string): boolean {
  return page.split("\n").filter((l) => /[A-Za-z].*\s\d{1,3}\s*$/.test(l)).length >= 5;
}

function cells(page: string, lines = 6): string[] {
  return page
    .split("\n")
    .filter((l) => l.trim())
    .slice(0, lines)
    .flatMap((l) => l.split(/\s{3,}/))
    .map((c) => c.trim())
    .filter(Boolean);
}

/** 1-based page numbers that are front or back matter. */
export function bookMatterPages(pages: string[]): Set<number> {
  const out = new Set<number>();
  const n = pages.length;

  // Front: everything before the first chapter opener, if one appears early.
  const opener = pages.findIndex((p, i) => i < 30 && !looksLikeContents(p) && cells(p, 2).some((c) => OPENER.test(c)));
  if (opener > 0) for (let i = 0; i < opener; i++) out.add(i + 1);

  // Back: from the first back-matter heading in the last 20% of the book.
  const back = pages.findIndex(
    (p, i) => i >= n * 0.8 && (cells(p, 3).some((c) => BACK_HEADINGS.has(c)) || ANSWER_KEY_OPENER.test(cells(p, 3).join(" "))),
  );
  if (back >= 0) for (let i = back; i < n; i++) out.add(i + 1);

  // Anywhere: pages that are matter by content (scrambled PDFs, stray pledges).
  pages.forEach((p, i) => {
    const head = cells(p, 4);
    if (MATTER_MARKERS.some((re) => head.some((c) => re.test(c))) || head.some((c) => BACK_HEADINGS.has(c) && i >= n * 0.8)) out.add(i + 1);
    if (p.trim().length < 40) out.add(i + 1);
  });
  return out;
}
