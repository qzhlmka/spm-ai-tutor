// One-off backfill: re-embed existing past_year_question chunks with a
// descriptive prefix (see src/lib/chunk-embedding-text.ts for why) so plain
// student requests like "give me a past year question on X" can actually
// retrieve them — previously these chunks' embeddings were the raw exam text
// alone, which doesn't semantically overlap with a meta-request about content
// type. Safe to re-run — just re-embeds the same rows again if run twice.
import { embedPassage } from "../lib/embeddings.js";
import { passageTextForChunk } from "../lib/chunk-embedding-text.js";
import { supabase } from "../lib/supabase.js";

const BATCH_SIZE = 50;

async function main() {
  let migrated = 0;
  let offset = 0;

  for (;;) {
    const { data: rows, error } = await supabase
      .from("content_chunks")
      .select("id, subject, topic, content")
      .eq("content_type", "past_year_question")
      .order("id")
      .range(offset, offset + BATCH_SIZE - 1);

    if (error) throw new Error(`Fetch failed: ${error.message}`);
    if (!rows || rows.length === 0) break;

    for (const row of rows) {
      const embedding = await embedPassage(
        passageTextForChunk({ content_type: "past_year_question", subject: row.subject, topic: row.topic, content: row.content }),
      );
      const { error: updateError } = await supabase
        .from("content_chunks")
        .update({ embedding })
        .eq("id", row.id);

      if (updateError) {
        console.error(`Row ${row.id} failed: ${updateError.message}`);
        continue;
      }
      migrated++;
    }
    console.log(`Re-embedded ${migrated} rows so far...`);
    offset += BATCH_SIZE;
  }

  console.log(`Done. ${migrated} past-year-question chunks re-embedded.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
