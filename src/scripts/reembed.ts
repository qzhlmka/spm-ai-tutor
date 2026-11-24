// One-off migration: backfill content_chunks.embedding_e5 (multilingual-e5-base,
// run in-process via src/lib/embeddings.ts) for every row that still only has
// the old gte-base embedding. Safe to re-run — only touches rows where
// embedding_e5 IS NULL, so an interrupted run just picks up where it left off.
//
// Prerequisite: sql/migrate_e5_base.sql must already be applied (adds the
// nullable embedding_e5 column). After this reports 0 remaining, apply
// sql/migrate_e5_base_finish.sql to swap the columns over.
//
// Uses embedPassage(), not embedQuery() — these are existing knowledge base
// chunks (documents), not student questions, and E5 models require the
// correct query/passage prefix or retrieval quality silently degrades.
import { embedPassage } from "../lib/embeddings.js";
import { supabase } from "../lib/supabase.js";

const BATCH_SIZE = 50;

async function main() {
  let migrated = 0;

  for (;;) {
    const { data: rows, error } = await supabase
      .from("content_chunks")
      .select("id, content")
      .is("embedding_e5", null)
      .limit(BATCH_SIZE);

    if (error) throw new Error(`Fetch failed: ${error.message}`);
    if (!rows || rows.length === 0) break;

    for (const row of rows) {
      const embedding = await embedPassage(row.content);
      const { error: updateError } = await supabase
        .from("content_chunks")
        .update({ embedding_e5: embedding })
        .eq("id", row.id);

      if (updateError) {
        console.error(`Row ${row.id} failed: ${updateError.message}`);
        continue;
      }
      migrated++;
      console.log(`Re-embedded ${migrated} rows so far...`);
    }
  }

  const { count, error: countError } = await supabase
    .from("content_chunks")
    .select("id", { count: "exact", head: true })
    .is("embedding_e5", null);

  if (countError) throw new Error(`Final count check failed: ${countError.message}`);

  console.log(`Done. ${migrated} rows re-embedded this run. ${count} rows still missing embedding_e5.`);
  if (count === 0) {
    console.log("All rows migrated — safe to run sql/migrate_e5_base_finish.sql now.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
