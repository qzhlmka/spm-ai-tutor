import path from "node:path";
import { extractPagesVision } from "../ingest/vision-extract.js";

const BASE = "./knowledge-bases/chemistry/NOTA CONTENGAN KELAS";

const SAMPLES = [
  "DELTA/FORM 4/C2 ATOMIC STRUCTURE/Note 9  Nov 2024 (Atomic Structure).pdf",
  "DELTA/FORM 4/C6 ACID & BES/Note 2 Dec 2024 .pdf",
  "DELTA/FORM 5/C2 CARBON COMPOUND/Note 26 Dec 2024.pdf",
  "DELTA/EXTRA CLASS/Conteng Kimia 23 Nov Cikgu Fana.pdf",
];

async function main() {
  for (const rel of SAMPLES) {
    const full = path.join(BASE, rel);
    const cacheDir = path.join(".cache", "vision-ocr", "sample-" + rel.replace(/[^a-zA-Z0-9]+/g, "-").slice(0, 60));
    console.log(`\n\n========== ${rel} ==========`);
    try {
      const pages = await extractPagesVision(full, cacheDir);
      console.log(`(${pages.length} pages)\n`);
      pages.forEach((p, i) => {
        console.log(`--- page ${i + 1} ---`);
        console.log(p.trim().slice(0, 600));
      });
    } catch (err) {
      console.error(`FAILED: ${(err as Error).message}`);
    }
  }
}
main();
