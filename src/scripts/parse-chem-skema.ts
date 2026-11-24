/**
 * Parses the Chemistry "SKEMA JAWAPAN MODUL SELEKOH" answer schemes.
 *
 * Unlike the Mathematics keys these open with an MCQ grid and then continue into
 * full worked solutions, so parsing has to stop at the end of the grid — the
 * solution text below is full of "1. (a) (i)" numbering that would otherwise be
 * read as answers.
 *
 * Numbers repeat in some grids with DIFFERENT letters (the F5 Polimer sheet lists
 * both "20 B" and "20 C"). That is an error in the source, and there is no way to
 * tell which is intended, so a conflicting number is dropped entirely rather than
 * resolved by picking one — losing a question is recoverable, teaching a wrong
 * answer as authoritative is the failure this whole pipeline exists to avoid.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);

export interface ChemKey {
  file: string;
  form: 4 | 5;
  bab: number;
  title: string;
  answers: Map<number, string>;
  conflicts: number[];
}

export async function parseChemSkema(pdfPath: string): Promise<ChemKey | null> {
  const { stdout } = await execFileAsync("pdftotext", ["-layout", pdfPath, "-"], { maxBuffer: 20 * 1024 * 1024 });
  const lines = stdout.split("\n");

  const header = stdout.match(/TINGKATAN\s+([45])\s*\(BAB\s+(\d+)\)\s*:?\s*([^\n]*)/i);
  if (!header) return null;

  const answers = new Map<number, string>();
  const seen = new Map<number, string>();
  const conflicts = new Set<number>();

  for (const line of lines) {
    // A grid row is only numbers and single letters. Once anything else of
    // substance appears we have reached the worked-solution section and must stop.
    const pairs = [...line.matchAll(/(?<![\d.])(\d{1,2})\s+([A-D])(?![A-Za-z0-9])/g)];
    if (pairs.length === 0) continue;
    const residue = line.replace(/(?<![\d.])\d{1,2}\s+[A-D](?![A-Za-z0-9])/g, "").replace(/\s+/g, "");
    if (residue.length > 2) continue;

    for (const m of pairs) {
      const num = Number(m[1]);
      const ans = m[2];
      const prev = seen.get(num);
      if (prev && prev !== ans) { conflicts.add(num); answers.delete(num); continue; }
      if (conflicts.has(num)) continue;
      seen.set(num, ans);
      answers.set(num, ans);
    }
  }

  return {
    file: path.basename(pdfPath),
    form: Number(header[1]) as 4 | 5,
    bab: Number(header[2]),
    title: header[3].trim(),
    answers,
    conflicts: [...conflicts].sort((a, b) => a - b),
  };
}
