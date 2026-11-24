/**
 * Proposes a canonical `topic` for every PDF in the class-notes tree, so the
 * notes land in the same topic vocabulary the Chemistry textbook already uses
 * rather than a parallel one built from folder names.
 *
 * Read-only: it writes a JSON review file and touches nothing in the database.
 * Filenames alone are not enough — plenty read "Note 17 Jan 2025 GC Combine" —
 * so each file's folder, name and first pages of extractable text are judged
 * together against a fixed topic list. Text extraction here is pdftotext, not
 * vision: these are annotated slides whose text layer is thin (~180 chars/page),
 * but for *classification* a few printed headings plus the path is plenty, and
 * paying for OCR twice would be silly when ingestion OCRs them properly anyway.
 */
import { readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { openai, CHUNKING_MODEL } from "../lib/openai.js";

const execFileAsync = promisify(execFile);

// The 13 topics the Chemistry textbook ingestion already uses, verbatim. A
// classification that isn't one of these is rejected rather than silently
// creating a 14th spelling of an existing topic.
const CANONICAL_TOPICS = [
  "Introduction to Chemistry",
  "Matter and the Atomic Structure",
  "The Mole Concept, Chemical Formula and Equation",
  "The Periodic Table of Elements",
  "Chemical Bond",
  "Acid, Base and Salt",
  "Rate of Reaction",
  "Manufactured Substances in Industry",
  "Redox Equilibrium",
  "Carbon Compound",
  "Thermochemistry",
  "Polymer",
  "Chemical Consumer",
] as const;

// Lab-practical modules (AMALI) teach apparatus, procedure and answering
// technique across every chapter at once, so forcing them into a content topic
// would file them under whichever chapter happened to supply the example.
const PRACTICAL_TOPIC = "Chemistry Practical (Amali)";

const TOPIC_OPTIONS = [...CANONICAL_TOPICS, PRACTICAL_TOPIC];

async function walkPdfs(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walkPdfs(full)));
    else if (entry.name.toLowerCase().endsWith(".pdf")) out.push(full);
  }
  return out;
}

async function firstPagesText(file: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("pdftotext", ["-l", "3", "-layout", file, "-"], {
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout.replace(/\s+/g, " ").trim().slice(0, 1500);
  } catch {
    return "";
  }
}

async function classify(relPath: string, sample: string): Promise<{ topic: string; confidence: string; reason: string }> {
  const response = await openai.chat.completions.create({
    model: CHUNKING_MODEL,
    temperature: 0,
    messages: [
      {
        role: "system",
        content:
          `You file Malaysian SPM Chemistry class notes under exactly one topic from this list:\n` +
          TOPIC_OPTIONS.map((t) => `- ${t}`).join("\n") +
          `\n\nThe notes are in Malay and English. Useful cues: "Termokimia"/"Haba" = Thermochemistry; ` +
          `"Formula Empirik"/"Magic Triangle"/"Teknik U"/"Persamaan Kimia" = The Mole Concept...; ` +
          `"Jadual Berkala"/"Saiz Atom"/"Kereaktifan" = The Periodic Table of Elements; ` +
          `"Ikatan" = Chemical Bond; "Asid"/"Bes"/"Garam"/"GTL"/"pH"/"Kation"/"Anion" = Acid, Base and Salt; ` +
          `"Sebatian Karbon" = Carbon Compound; "Redoks" = Redox Equilibrium; ` +
          `"Aloi"/"Kaca"/"Seramik" = Manufactured Substances in Industry; ` +
          `"Polimer"/"Getah"/"Pemvulkanan" = Polymer; "KTB" = Rate of Reaction; ` +
          `"Konsumer"/"Sabun"/"Detergen" = Chemical Consumer; "Amali"/"Modul Amali" = Chemistry Practical (Amali).\n\n` +
          `A folder named for a chapter (e.g. "BAB 5 IKATAN KIMIA", "C3 THERMOCHEMISTRY") is the strongest ` +
          `signal available — trust it over the filename. Reply with JSON only: ` +
          `{"topic": "<exact option>", "confidence": "high"|"medium"|"low", "reason": "<8 words max>"}. ` +
          `Use "low" when you are guessing from a date or a vague name rather than real subject-matter evidence.`,
      },
      { role: "user", content: `PATH: ${relPath}\n\nFIRST PAGES OF TEXT:\n${sample || "(no extractable text)"}` },
    ],
    response_format: { type: "json_object" },
  });
  const parsed = JSON.parse(response.choices[0]?.message?.content ?? "{}");
  const topic = TOPIC_OPTIONS.includes(parsed.topic) ? parsed.topic : "UNRESOLVED";
  return { topic, confidence: parsed.confidence ?? "low", reason: parsed.reason ?? "" };
}

async function main() {
  const root = process.argv[2];
  if (!root) throw new Error("Usage: tsx src/scripts/classify-notes.ts <folder>");

  const files = (await walkPdfs(root)).sort();
  console.log(`Found ${files.length} PDFs.`);

  // Byte-identical copies of the same lesson exist across the class folders.
  // Classify one representative and record the rest as its duplicates, so the
  // review table has one row per distinct document.
  const byHash = new Map<string, string[]>();
  for (const f of files) {
    const hash = createHash("sha256").update(await readFile(f)).digest("hex");
    byHash.set(hash, [...(byHash.get(hash) ?? []), f]);
  }
  console.log(`${byHash.size} unique documents (${files.length - byHash.size} byte-identical copies).`);

  const results = [];
  let done = 0;
  for (const [hash, paths] of byHash) {
    const primary = paths[0];
    const rel = path.relative(root, primary);
    const sample = await firstPagesText(primary);
    const { topic, confidence, reason } = await classify(rel, sample);
    const pages = Number(
      (await execFileAsync("pdfinfo", [primary]).catch(() => ({ stdout: "" }))).stdout.match(/^Pages:\s+(\d+)/m)?.[1] ?? 0,
    );
    results.push({
      hash,
      file: rel,
      duplicates: paths.slice(1).map((p) => path.relative(root, p)),
      pages,
      textChars: sample.length,
      topic,
      confidence,
      reason,
    });
    done++;
    if (done % 10 === 0) console.log(`  classified ${done}/${byHash.size}`);
  }

  results.sort((a, b) => a.topic.localeCompare(b.topic) || a.file.localeCompare(b.file));
  const out = path.resolve("notes-topics.json");
  await writeFile(out, JSON.stringify(results, null, 2));
  console.log(`\nWrote ${out}`);

  const byTopic = new Map<string, number>();
  for (const r of results) byTopic.set(r.topic, (byTopic.get(r.topic) ?? 0) + 1);
  console.log("\nProposed topics:");
  for (const [t, n] of [...byTopic].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)}  ${t}`);
  const lowConf = results.filter((r) => r.confidence === "low" || r.topic === "UNRESOLVED");
  console.log(`\nNeeds review (low confidence or unresolved): ${lowConf.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
