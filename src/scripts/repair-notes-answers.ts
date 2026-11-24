/**
 * DO NOT RUN THIS TO ATTACH ANSWERS. Kept as the record of a failed approach;
 * only the `--no-key` path (plain re-ingest, no answer key) is safe. See the
 * "Number-based pairing" note in CLAUDE.md before touching it.
 *
 * Re-ingests the class-note files whose questions were dropped for having no
 * answer, this time supplying the official SKEMA answer key.
 *
 * Those notes bundle printed MODUL SELEKOH question pages the teacher never
 * annotated; the answers to them live in chemistry/SKEMA SELEKOH/ as separate
 * per-chapter files. 249 chunks were discarded on the first pass for exactly
 * this reason — the same questions-and-answers-in-different-files shape already
 * handled for Mathematics, so it reuses the same code-side lookup.
 *
 * Deliberately conservative about which files it touches:
 *  - only files that actually lost chunks (re-running the rest costs money and
 *    risks perturbing chunks that are already correct),
 *  - only topics served by exactly ONE answer scheme. Two schemes both cover
 *    "Acid, Base and Salt" (BAB 6 ASID BES and BAB 6 GARAM) with independent
 *    numbering, so there is no safe way to know which grid a given question
 *    belongs to; those files are skipped and reported rather than guessed at.
 */
import { readFile } from "node:fs/promises";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { supabase } from "../lib/supabase.js";
import { extractPagesVision } from "../ingest/vision-extract.js";
import { runIngestion } from "../ingest/ingest.js";
import { parseChemSkema, type ChemKey } from "./parse-chem-skema.js";
import { extractMcqs, validateAlignment } from "./validate-key-alignment.js";

/** A file must clear this before any of its answers are written. Calibrated
 * against files of known status: the printed module scored 80%, a teacher
 * worksheet on the same chapter 20% (chance is 25% on four options), and a
 * workbook 40%. Anything below this is not the module the key was written for. */
const MIN_ALIGNMENT = 0.7;
const ALIGNMENT_SAMPLE = 15;

const NOTES_ROOT = `${os.homedir()}/Desktop/knowledge bases/chemistry/NOTA CONTENGAN KELAS`;
const SKEMA_ROOT = `${os.homedir()}/Desktop/knowledge bases/chemistry/SKEMA SELEKOH`;

const CHAPTER_TOPIC: Record<string, string> = {
  "4:2": "Matter and the Atomic Structure",
  "4:3": "The Mole Concept, Chemical Formula and Equation",
  "4:4": "The Periodic Table of Elements",
  "4:5": "Chemical Bond",
  "4:6": "Acid, Base and Salt",
  "4:7": "Rate of Reaction",
  "4:8": "Manufactured Substances in Industry",
  "5:1": "Redox Equilibrium",
  "5:2": "Carbon Compound",
  "5:3": "Thermochemistry",
  "5:4": "Polymer",
  "5:5": "Chemical Consumer",
};

function walk(d: string): string[] {
  return readdirSync(d).flatMap((e) => {
    const p = path.join(d, e);
    return statSync(p).isDirectory() ? walk(p) : p.toLowerCase().endsWith(".pdf") ? [p] : [];
  });
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  // Re-ingest with no key at all, restoring the pre-repair state. Needed because
  // pairing by question number is only valid for note files that ARE the printed
  // MODUL SELEKOH; a teacher's own worksheet on the same chapter numbers its
  // questions independently, and matching those against the module key produced
  // confidently wrong answers ("Which element is in Group 18?" answered A, not
  // Neon). See the note in CLAUDE.md before attempting this pairing again.
  const noKey = process.argv.includes("--no-key");

  const keysByTopic = new Map<string, ChemKey[]>();
  for (const f of walk(SKEMA_ROOT)) {
    const k = await parseChemSkema(f);
    if (!k) continue;
    const topic = CHAPTER_TOPIC[`${k.form}:${k.bab}`];
    if (!topic) continue;
    keysByTopic.set(topic, [...(keysByTopic.get(topic) ?? []), k]);
  }

  const usable = new Map<string, ChemKey>();
  for (const [topic, ks] of keysByTopic) {
    if (ks.length === 1) usable.set(topic, ks[0]);
    else console.log(`AMBIGUOUS, skipping topic "${topic}" — ${ks.length} schemes: ${ks.map((k) => k.file).join(", ")}`);
  }
  console.log(`Usable answer schemes: ${usable.size} topics, ${[...usable.values()].reduce((s, k) => s + k.answers.size, 0)} answers.\n`);

  const topics: { file: string; topic: string }[] = JSON.parse(await readFile("notes-topics.json", "utf-8"));
  const topicOf = new Map(topics.map((t) => [t.file, t.topic]));
  const drops = (await readFile("/tmp/drops.txt", "utf-8")).trim().split("\n").map((l) => {
    const [n, ...rest] = l.split("|");
    return { dropped: Number(n), file: rest.join("|") };
  });

  let repaired = 0, skipped = 0, added = 0, before = 0;
  for (const d of drops) {
    const topic = topicOf.get(d.file);
    const key = topic ? usable.get(topic) : undefined;
    if (!key || !topic) { console.log(`skip (${d.dropped} dropped) — no unambiguous scheme for "${topic}": ${d.file}`); skipped++; continue; }

    const abs = path.join(NOTES_ROOT, d.file);
    const buffer = await readFile(abs);
    const hash = createHash("sha256").update(buffer).digest("hex");
    const { data: material } = await supabase.from("materials").select("id, filename").eq("content_hash", hash).maybeSingle();
    if (!material) { console.log(`skip — no materials row: ${d.file}`); skipped++; continue; }

    const { count } = await supabase.from("content_chunks").select("id", { count: "exact", head: true }).eq("material_id", material.id);
    console.log(`\n${d.file}\n  topic ${topic} | ${d.dropped} dropped | ${count} chunks now | key ${key.file} (${key.answers.size})`);
    if (dryRun) { repaired++; before += count ?? 0; continue; }

    const pages = await extractPagesVision(abs, path.join(".ocr-cache", hash.slice(0, 16)));

    // Gate BEFORE touching the database: pairing on question number is only valid
    // when this file is the module the key was written for, and nothing in the
    // file's name, labels or numbering reveals that reliably.
    if (noKey) {
      await supabase.from("content_chunks").delete().eq("material_id", material.id);
      const { chunkCount } = await runIngestion({ pages, examBoard: "SPM", subject: "Chemistry", topic,
        materialId: material.id, sourceFile: material.filename });
      await supabase.from("materials").update({ chunk_count: chunkCount }).eq("id", material.id);
      console.log(`  -> ${chunkCount} chunks (was ${count}) [reverted, no key]`);
      before += count ?? 0; added += chunkCount; repaired++;
      continue;
    }
    const mcqs = extractMcqs(pages);
    const align = await validateAlignment(mcqs, key.answers, ALIGNMENT_SAMPLE);
    console.log(`  alignment: ${align.agreed}/${align.sampled} = ${(align.rate * 100).toFixed(0)}%`);
    if (align.rate < MIN_ALIGNMENT) {
      align.disagreements.forEach((d) => console.log(`    ${d}`));
      console.log(`  REJECTED — below ${MIN_ALIGNMENT * 100}%, this is not the module this key answers.`);
      skipped++;
      continue;
    }

    await supabase.from("content_chunks").delete().eq("material_id", material.id);
    const { chunkCount } = await runIngestion({
      pages,
      examBoard: "SPM",
      subject: "Chemistry",
      topic,
      materialId: material.id,
      sourceFile: material.filename,
      answerKey: noKey ? undefined : key.answers,
    });
    await supabase.from("materials").update({ chunk_count: chunkCount }).eq("id", material.id);
    console.log(`  -> ${chunkCount} chunks (was ${count})`);
    before += count ?? 0;
    added += chunkCount;
    repaired++;
  }

  console.log(`\n${repaired} files repaired, ${skipped} skipped.`);
  if (!dryRun) console.log(`Chunks: ${before} -> ${added} (${added - before >= 0 ? "+" : ""}${added - before})`);
}

main().catch((e) => { console.error(e); process.exit(1); });
