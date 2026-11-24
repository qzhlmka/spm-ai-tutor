// One-off backfill: re-embed existing teacher-material chunks (content_chunks
// rows with material_id set) with a subject/topic-anchored prefix (see
// src/lib/chunk-embedding-text.ts for why) — these were previously embedded
// as bare content with no subject/topic/English signal, which made them
// effectively unretrievable against plain English questions in a KB dominated
// by other subjects. Safe to re-run — just re-embeds the same rows again.
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
      .select("id, subject, topic, content_type, content")
      .not("material_id", "is", null)
      .order("id")
      .range(offset, offset + BATCH_SIZE - 1);

    if (error) throw new Error(`Fetch failed: ${error.message}`);
    if (!rows || rows.length === 0) break;

    for (const row of rows) {
      const embedding = await embedPassage(
        passageTextForChunk({
          content_type: row.content_type,
          subject: row.subject,
          topic: row.topic,
          content: row.content,
          isTeacherMaterial: true,
        }),
      );
      const { error: updateError } = await supabase.from("content_chunks").update({ embedding }).eq("id", row.id);

      if (updateError) {
        console.error(`Row ${row.id} failed: ${updateError.message}`);
        continue;
      }
      migrated++;
    }
    console.log(`Re-embedded ${migrated} rows so far...`);
    offset += BATCH_SIZE;
  }

  console.log(`Done. ${migrated} teacher-material chunks re-embedded.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
