import { supabase } from "./supabase.js";
import type { RetrievedChunk } from "./chat-handler.js";

/** Which table the whole-knowledge-base lanes read (RAG_STATUS.md, Phase 5 → integration).
 *
 * `content_chunks` is the live knowledge base. `kb_chunks` is the rebuild
 * (sql/migrate_add_kb_chunks.sql): 16 textbooks re-ingested with exact pages,
 * front/back matter dropped, plus the live teacher and past-year rows carried
 * over with their vectors. Searched by kb_search — vector + BM25 fused by RRF —
 * which measured R@5 0.872 / MRR 0.766 on the pilot through the database, and
 * in answer evals gave half the false refusals of the live lanes (5/73 vs
 * 11/73) at equal or better faithfulness.
 *
 * Only the whole-KB lanes switch. The teacher vector lane + relevance judge,
 * the teacher lexical lane and the exam-label lane keep reading content_chunks
 * either way: they are tuned against it, and a teacher upload made after the
 * carry-over exists only there. */
export type RetrievalBackend = "content_chunks" | "kb_chunks";

type KbRow = {
  id: number;
  origin: "textbook" | "carried_teacher" | "carried_past_year" | "carried_revision";
  doc_id: string;
  page: number;
  subject: string | null;
  content: string;
  content_type: string | null;
  source: string | null;
  material_id: string | null;
  source_page_images: string[] | null;
};

/** One kb_search lane, in the shape the rest of retrieval uses.
 *
 * A carried row's id is its content_chunks id (legacy_chunk_id), not the
 * kb_chunks one. The teacher and exam lanes return content_chunks ids, so this
 * is what lets the merge dedupe a chunk found by both — and keeps a gated
 * teacher chunk labelled as the student's teacher's material rather than
 * appearing twice, once unlabelled. kb_search does not return the column, so
 * it is looked up for the carried rows only (textbook rows have none). */
export async function kbSearch(
  embedding: number[],
  queryText: string,
  lane: "main" | "past_year",
  matchCount: number,
): Promise<{ data: RetrievedChunk[]; error: unknown }> {
  const { data, error } = await supabase.rpc("kb_search", {
    query_embedding: `[${embedding.join(",")}]`,
    query_text: queryText,
    lane,
    match_count: matchCount,
  });
  if (error) return { data: [], error };
  const rows = (data ?? []) as KbRow[];

  const carried = rows.filter((r) => r.origin !== "textbook").map((r) => r.id);
  const legacy = new Map<number, string>();
  if (carried.length > 0) {
    const lookup = await supabase.from("kb_chunks").select("id, legacy_chunk_id").in("id", carried);
    if (lookup.error) return { data: [], error: lookup.error };
    for (const r of lookup.data ?? []) if (r.legacy_chunk_id) legacy.set(r.id, r.legacy_chunk_id);
  }

  return {
    data: rows.map((r) => ({
      id: legacy.get(r.id) ?? `kb:${r.id}`,
      content: r.content,
      // A rebuilt textbook row has no LLM-written source note; its book and
      // physical page are the citation, and are exact.
      source: r.origin === "textbook" ? `${r.doc_id}, page ${r.page}` : r.source,
      content_type: r.content_type ?? "textbook page",
      difficulty: null,
      material_id: r.material_id,
      subject: r.subject,
      source_page_images: r.source_page_images,
    })),
    error: null,
  };
}
