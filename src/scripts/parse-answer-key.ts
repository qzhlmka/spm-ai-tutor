/**
 * Parses a "SKEMA KERTAS" answer-key PDF into a compact lookup keyed by
 * chapter and question number.
 *
 * These keys are published as a separate file from the question book, which is
 * why the generic ingester produces nothing useful from either half on its own:
 * the question book has no answers, and the key on its own is a grid of bare
 * letters. Ingesting the key alone was tried and produced chunks reading
 * "Soalan 1: Jawapan: C" with no question attached — worse than useless, since
 * they retrieve against real questions.
 *
 * The text layer is clean here (it is a typeset grid, not annotated slides), so
 * this deliberately uses pdftotext rather than vision — no OCR cost, no OCR
 * error on single letters, which is exactly where a vision model is weakest.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface AnswerKeyChapter {
  bab: number;
  title: string;
  answers: Map<number, string>;
}

export async function parseAnswerKey(pdfPath: string): Promise<AnswerKeyChapter[]> {
  const { stdout } = await execFileAsync("pdftotext", ["-layout", pdfPath, "-"], {
    maxBuffer: 20 * 1024 * 1024,
  });

  const chapters: AnswerKeyChapter[] = [];
  let current: AnswerKeyChapter | null = null;

  for (const line of stdout.split("\n")) {
    const header = line.match(/BAB\s+(\d+)\s*[:.]?\s*(.*)/i);
    if (header) {
      current = { bab: Number(header[1]), title: header[2].trim(), answers: new Map() };
      chapters.push(current);
      continue;
    }
    if (!current) continue;

    // Answers appear as "1.  C" or "21  D" — the dot is inconsistent, and a
    // question with no published answer appears as a bare number or "N/A".
    // Requiring whitespace between number and letter is what stops "1" and a
    // neighbouring cell's letter from being glued into a false pair.
    for (const m of line.matchAll(/(?<![\d.])(\d{1,2})\.?\s+([A-D]|N\/A)(?![A-Za-z0-9])/g)) {
      const num = Number(m[1]);
      const ans = m[2];
      if (ans !== "N/A" && !current.answers.has(num)) current.answers.set(num, ans);
    }
  }
  return chapters.filter((c) => c.answers.size > 0);
}

/** Flat text form handed to the chunking model alongside the question pages. */
export function formatAnswerKey(chapters: AnswerKeyChapter[], formLabel: string): string {
  return chapters
    .map((c) => {
      const pairs = [...c.answers].sort((a, b) => a[0] - b[0]).map(([n, a]) => `${n}=${a}`).join("  ");
      return `${formLabel} BAB ${c.bab} (${c.title}): ${pairs}`;
    })
    .join("\n");
}

if (process.argv[1]?.endsWith("parse-answer-key.ts")) {
  const chapters = await parseAnswerKey(process.argv[2]);
  console.log(formatAnswerKey(chapters, process.argv[3] ?? "F?"));
  console.log(`\n${chapters.length} chapters, ${chapters.reduce((s, c) => s + c.answers.size, 0)} answers`);
}
