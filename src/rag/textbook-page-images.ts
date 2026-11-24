/**
 * Page images for the rebuilt textbooks in kb_chunks, so the tutor can show a
 * textbook figure the way it already shows a past-year question's diagram
 * (resolveExamPageImages in chat-handler.ts).
 *
 * Every textbook row in kb_chunks has an exact physical page (the reason the
 * textbooks were rebuilt page by page), so no matching is needed: render each
 * page that has chunks, upload it to the private exam-page-images bucket under
 * kb-textbook/<doc>/page-NNNN.jpg, and point that page's rows at it. JPEG
 * rather than PNG: ~40% of the size at 150 dpi (the bucket's existing PNGs
 * average ~370 KB), and a figure is cropped and re-encoded as PNG before it is
 * shown anyway.
 *
 * Writes: storage objects (upsert) and kb_chunks.source_page_images for
 * origin = 'textbook' rows only. Idempotent — re-running re-uploads the same
 * paths and sets the same values.
 *
 *   npx tsx --env-file=.env src/rag/textbook-page-images.ts --doc "Textbook Physics Form 5 (English)" [--dry-run]
 *   npx tsx --env-file=.env src/rag/textbook-page-images.ts --all
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { supabase } from "../lib/supabase.js";
import { KB_ROOT, readDocList } from "./docs.js";

const arg = (k: string, d = "") => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
const dryRun = process.argv.includes("--dry-run");
const docs = readDocList("corpus-textbooks.txt").filter((d) => process.argv.includes("--all") || d.docId === arg("--doc"));
if (docs.length === 0) throw new Error('pass --doc "<doc id>" (see corpus-textbooks.txt) or --all');

const BUCKET = "exam-page-images";
const RENDER_DPI = 150;
const RENDER_FIXED_ROOT = path.resolve(".cache/render-fixed"); // as vision-extract.ts, so figures look the same as the existing past-year pages
const slug = (docId: string) => docId.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
const storagePath = (docId: string, page: number) => `kb-textbook/${slug(docId)}/page-${String(page).padStart(4, "0")}.jpg`;

async function pagesOf(docId: string): Promise<number[]> {
  const pages = new Set<number>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from("kb_chunks").select("page").eq("origin", "textbook").eq("doc_id", docId).order("id").range(from, from + 999);
    if (error) throw error;
    for (const r of data ?? []) if (r.page > 0) pages.add(r.page);
    if ((data ?? []).length < 1000) break;
  }
  return [...pages].sort((a, b) => a - b);
}

/** Renders the whole PDF once (one pdftoppm process is far faster than one per page). */
function render(file: string, docId: string): string {
  const dir = path.resolve(".cache/page-images", slug(docId));
  if (existsSync(dir) && readdirSync(dir).some((f) => f.endsWith(".jpg"))) return dir;
  mkdirSync(dir, { recursive: true });
  // A copy with zero-size form BBoxes repaired (src/rag/repair_bbox.py) when one
  // exists: two books render ~85% blank without it.
  const fixed = path.join(RENDER_FIXED_ROOT, path.basename(file));
  execFileSync("pdftoppm", ["-jpeg", "-jpegopt", "quality=82", "-r", String(RENDER_DPI), existsSync(fixed) ? fixed : path.join(KB_ROOT, file), path.join(dir, "p")]);
  return dir;
}

/** pdftoppm pads page numbers to the width of the page count ("p-007.jpg"), so match on the number. */
function renderedFile(dir: string, page: number): string | undefined {
  const f = readdirSync(dir).find((n) => Number(/-(\d+)\.jpg$/.exec(n)?.[1]) === page);
  return f && path.join(dir, f);
}

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) await fn(items[i++]); }));
}

for (const doc of docs) {
  const pages = await pagesOf(doc.docId);
  const t0 = Date.now();
  const dir = render(doc.file, doc.docId);
  const files = pages.map((p) => ({ page: p, file: renderedFile(dir, p) }));
  const missing = files.filter((f) => !f.file).map((f) => f.page);
  const bytes = files.reduce((a, f) => a + (f.file ? statSync(f.file).size : 0), 0);
  console.log(`${doc.docId}: ${pages.length} pages with chunks, rendered in ${((Date.now() - t0) / 1000).toFixed(0)} s, ${(bytes / 1e6).toFixed(1)} MB${missing.length ? `, NOT RENDERED: ${missing.join(",")}` : ""}`);
  if (dryRun) continue;

  let uploaded = 0, updated = 0;
  const failures: string[] = [];
  await pool(files.filter((f) => f.file), 6, async ({ page, file }) => {
    const target = storagePath(doc.docId, page);
    const up = await supabase.storage.from(BUCKET).upload(target, readFileSync(file!), { contentType: "image/jpeg", upsert: true });
    if (up.error) { failures.push(`upload p${page}: ${up.error.message}`); return; }
    uploaded++;
    const { error, count } = await supabase.from("kb_chunks").update({ source_page_images: [target] }, { count: "exact" })
      .eq("origin", "textbook").eq("doc_id", doc.docId).eq("page", page);
    if (error) failures.push(`update p${page}: ${error.message}`);
    else updated += count ?? 0;
  });
  console.log(`  uploaded ${uploaded} pages, pointed ${updated} chunks at them${failures.length ? `\n  FAILURES (${failures.length}):\n    ${failures.slice(0, 10).join("\n    ")}` : ""}`);
}
process.exit(0);
