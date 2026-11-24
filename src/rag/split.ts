/**
 * Baseline splitter (rag-stack Phase 2): recursive character splitting at
 * ~1000 characters with 150 overlap, per page, so every chunk keeps its exact
 * page number. Prefers paragraph, then line, then sentence, then word breaks.
 * Deliberately the simplest thing; Phase 3 compares alternatives against it.
 */
export const CHUNK_SIZE = 1000;
export const CHUNK_OVERLAP = 150;
const SEPARATORS = ["\n\n", "\n", ". ", " "];

function splitRecursive(text: string, seps: string[]): string[] {
  if (text.length <= CHUNK_SIZE) return [text];
  const [sep, ...rest] = seps;
  if (sep === undefined) {
    const out: string[] = [];
    for (let i = 0; i < text.length; i += CHUNK_SIZE - CHUNK_OVERLAP) out.push(text.slice(i, i + CHUNK_SIZE));
    return out;
  }
  const pieces = text.split(sep).flatMap((p) => (p.length > CHUNK_SIZE ? splitRecursive(p, rest) : [p]));
  const chunks: string[] = [];
  let cur = "";
  for (const piece of pieces) {
    if (cur && cur.length + sep.length + piece.length > CHUNK_SIZE) {
      chunks.push(cur);
      // Carry the tail of the previous chunk forward as overlap.
      const tail = cur.slice(-CHUNK_OVERLAP);
      cur = tail.includes(" ") ? tail.slice(tail.indexOf(" ") + 1) : "";
    }
    cur = cur ? cur + sep + piece : piece;
  }
  if (cur.trim()) chunks.push(cur);
  return chunks;
}

/** Chunks for one page's text, whitespace-normalised, empty ones dropped. */
export function splitPage(text: string): string[] {
  // NFKC folds ligatures ("ﬁ" -> "fi") that otherwise break keyword search.
  // It cannot restore superscripts the PDF text layer already flattened
  // ("10^24" arrives as "1024") — that needs OCR on equation-heavy pages.
  const normalised = text
    .normalize("NFKC")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return splitRecursive(normalised, SEPARATORS)
    .map((c) => c.trim())
    .filter((c) => c.length >= 40);
}
