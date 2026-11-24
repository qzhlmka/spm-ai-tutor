// Extends each chunk's source_page_images by N pages AFTER its last stored page.
// A past-year question's figure can sit a page or two past where its text
// matched; the pointer then never included it and the diagram locator had
// nothing to find. Pointers only: no rows deleted, nothing re-chunked or
// re-embedded, no OCR (page PNGs come from .cache/vision-ocr/). NOT idempotent —
// running twice widens twice — so each run backs the old pointers up first.
//
// Usage: npx tsx src/scripts/widen-page-images.ts [--dry-run] [--extra N] <storagePrefix>... | --all
//   e.g. sources/chemistry-form-5-kssm-pdf   materials/<id>
import { appendFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { supabase } from "../lib/supabase.js";
import { uploadPageImages } from "../ingest/ingest.js";
import { pageImagePathsFor } from "../ingest/vision-extract.js";

const BACKUP_FILE = path.join(".cache", "backups", `page-images-before-widen-${new Date().toISOString().slice(0, 10)}.jsonl`);
const CACHE_ROOT = path.join(".cache", "vision-ocr");

const norm = (s: string) => s.toLowerCase().replace(/\.pdf$/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

async function cacheDirFor(prefix: string): Promise<string | null> {
  if (prefix.startsWith("materials/")) return path.join(CACHE_ROOT, `material-${prefix.slice("materials/".length)}`);
  const want = norm(prefix.replace(/^sources\//, "").replace(/-pdf$/, ""));
  const dirs = await readdir(CACHE_ROOT);
  const hit = dirs.find((d) => norm(d) === want);
  return hit ? path.join(CACHE_ROOT, hit) : null;
}

const pageNo = (p: string) => Number(/page-(\d+)\.png$/.exec(p)?.[1]);

type Row = { id: string; source_page_images: string[] };

async function loadAll(): Promise<Row[]> {
  const rows: Row[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("content_chunks")
      .select("id, source_page_images")
      .not("source_page_images", "is", null)
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as Row[]));
    if ((data ?? []).length < 1000) break;
  }
  return rows;
}

async function widenPrefix(prefix: string, all: Row[], extra: number, dryRun: boolean): Promise<void> {
  const cacheDir = await cacheDirFor(prefix);
  const images = cacheDir ? await pageImagePathsFor(cacheDir) : [];
  if (!cacheDir || images.length === 0) {
    console.error(`[${prefix}] no cached page images — skipping`);
    return;
  }
  const rows = all.filter((r) => r.source_page_images.every((p) => p.startsWith(`${prefix}/`)));
  let changed = 0;
  let added = 0;
  for (const r of rows) {
    const pages = r.source_page_images.map(pageNo);
    if (pages.some((n) => !Number.isFinite(n))) continue;
    const last = Math.max(...pages);
    const want: number[] = [];
    for (let n = last + 1; n <= Math.min(last + extra, images.length); n++) if (!pages.includes(n)) want.push(n);
    if (want.length === 0) continue;
    changed++;
    added += want.length;
    if (dryRun) continue;
    const uploaded = await uploadPageImages(prefix, images, want.map((n) => n - 1), 0);
    const next = [...new Set([...r.source_page_images, ...uploaded])];
    await appendFile(BACKUP_FILE, JSON.stringify({ id: r.id, source_page_images: r.source_page_images }) + "\n");
    const { error } = await supabase.from("content_chunks").update({ source_page_images: next }).eq("id", r.id);
    if (error) console.error(`[${prefix}] update ${r.id} failed: ${error.message}`);
  }
  console.log(`[${prefix}] ${rows.length} chunks, ${changed} widened (+${added} page refs, ${images.length} pages in doc)${dryRun ? " [dry run]" : ""}`);
}

async function main() {
  await mkdir(path.dirname(BACKUP_FILE), { recursive: true });
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const ei = args.indexOf("--extra");
  const extra = ei >= 0 ? Number(args[ei + 1]) : 1;
  const all = await loadAll();
  let prefixes = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--extra");
  if (args.includes("--all")) prefixes = [...new Set(all.flatMap((r) => r.source_page_images.map((p) => p.replace(/\/[^/]+$/, ""))))];
  if (prefixes.length === 0) {
    console.error("Usage: widen-page-images.ts [--dry-run] [--extra N] <storagePrefix>... | --all");
    process.exit(1);
  }
  console.log(`Old pointers backed up to ${BACKUP_FILE}`);
  for (const p of prefixes) await widenPrefix(p, all, extra, dryRun);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
