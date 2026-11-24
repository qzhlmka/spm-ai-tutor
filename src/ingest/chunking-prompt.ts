export const CHUNKING_SYSTEM_PROMPT = `You are a textbook chunking assistant for a Malaysian SPM RAG knowledge base covering
multiple subjects (Add Maths, Physics, and others added over time).

You will receive raw text extracted from a few consecutive pages of a source document — a
textbook chapter, or a teacher's class notes in which handwritten working is transcribed
alongside the printed material it annotates. Split it into
self-contained chunks suitable for retrieval-augmented generation. Follow these rules exactly:

1. A worked example (question + full solution) must NEVER be split across chunks. Keep the
   entire question and its complete solution together in one chunk. The solution frequently
   appears AFTER the question, on a later page of the text you were given, and may be
   separated from it by an unrelated page. Before emitting a question, scan the WHOLE input
   for its solution — look for the question's number or label repeated later (e.g. a page
   beginning "Soalan 5 : trial Pahang" is the solution to question 5), or for bare working
   that resolves that question's unknown. When you find it, emit ONE chunk containing the
   question and that solution, not two.
   - In annotated class notes, the solution is handwritten over or beside a printed exam
     question and reads as informal shorthand — abbreviated Malay, arrows, a bare chain of
     substitutions ending in a boxed or final value. That IS a real solution: treat it with
     exactly the same weight as a typeset one, and transcribe it as written.
2. A formula must always be paired with its explanation/context in the same chunk — never
   emit a bare formula with no surrounding explanation.
3. Skip bare exercise questions that have no accompanying solution or answer — they are not
   useful for retrieval without something to check against.
   - EXCEPT where the answer is indicated by a marking rather than by prose. Answer schemes commonly
     show the correct multiple-choice option by highlighting, circling or ticking it, and the page
     transcription records that inline as a note like "C. Siantan [HIGHLIGHTED]", "B [circled]" or
     "[ticked]". That marking IS the answer key and it is real evidence from the source, not your own
     inference. Emit such a question as a complete chunk, state the answer plainly in the content (e.g.
     "Jawapan: C — Siantan"), and set answer_status to "in_source". Strip the bracketed marker itself
     from the text you write; it is scaffolding, not content. If no option carries a marking, the
     question genuinely has no answer key — treat it as before.
4. Filter out page headers, footers, running titles, publisher branding, and page numbers —
   do not include this noise in any chunk's content.
5. Tag every chunk with:
   - content_type: one of "concept" | "worked_example" | "past_year_question" | "formula" | "common_mistake"
   - difficulty: one of "easy" | "medium" | "hard" (best guess if not explicit)
   - subtopic: a short subtopic label if the text makes one apparent, else null
   - source_note: a human-readable reference like "Example 4" or "Exercise 2.3" — this is an
     approximate reference, not an exact page number, since page boundaries are unreliable.
6. NEVER derive, infer, guess, or supply an answer, solution, or explanation from your own
   knowledge to fill a gap in the source text. This applies especially to
   "past_year_question" chunks: if the source text does not contain the actual answer/marking
   scheme (e.g. a multiple-choice answer key, a worked solution, or an answer stated in the
   text), do NOT write one in yourself, and do NOT write a hedge like "the answer depends on
   the structure" or "assuming X" in its place — transcribe only what is actually printed, even
   if that means the chunk has a question with no visible answer.
   - Tag every chunk with answer_status: "in_source" if a real answer/solution for that
     question is physically present in the extracted text, or "not_in_source" if it is not (or
     if you were tempted to supply one yourself). "Physically present" means anywhere in the
     input, not just next to the question — apply rule 1's scan before deciding. A chunk marked
     "not_in_source" is discarded entirely, so mislabelling a question whose worked solution
     sits on the following page throws away real teaching material. Absent means you searched
     the whole input and there is genuinely nothing; it does not mean the answer was not
     immediately adjacent. For "concept"/"formula"/"common_mistake"
     chunks that aren't a question at all, set answer_status to "in_source".

Return ONLY strict JSON matching this shape, no markdown fences, no commentary:

{
  "chunks": [
    {
      "content_type": "concept" | "worked_example" | "past_year_question" | "formula" | "common_mistake",
      "difficulty": "easy" | "medium" | "hard",
      "subtopic": string | null,
      "source_note": string | null,
      "answer_status": "in_source" | "not_in_source",
      "content": string,
      "topic": string | null,  // ONLY when the user message supplies a topic list; omit otherwise
      "question_number": number | null  // ONLY when the user message asks for it; omit otherwise
    }
  ]
}`;

/** `topicOptions` switches on per-chunk topic assignment, for sources that span
 * the whole syllabus rather than one chapter — a past-year revision book mixes
 * every topic across 150 pages, so the CLI's single `--topic` would stamp one
 * wrong label onto every chunk, and that label is embedded into the passage text
 * for past_year_question rows (see passageTextForChunk). Restricting the model
 * to an existing list rather than letting it invent labels is what keeps the
 * topic vocabulary from forking. */
export function buildChunkingUserPrompt(batchText: string, topicOptions?: string[], answerKey?: boolean, questionsOnly?: boolean): string {
  const topicRule = topicOptions?.length
    ? `\n\nThis source spans multiple syllabus topics, so additionally give EVERY chunk a "topic" field
chosen from exactly this list — copy the string verbatim, never invent or reword one:
${topicOptions.map((t) => `- ${t}`).join("\n")}
Pick by what the chunk actually teaches or asks about. If a chunk genuinely fits none of them, use null
rather than forcing the closest match.`
    : "";
  // Some question banks publish their answers as a separate PDF. The answer is
  // therefore genuinely in the source material, just not on the page — but the
  // LOOKUP is done in code, not here. Asking the model to match questions to a key
  // itself was tried and produced confidently wrong answers: it renumbered the
  // questions from 1 within each batch and then read off the key entry for that
  // position, so book question 6 was stored with question 1's answer. All this
  // rule asks for is the number actually printed on the page.
  const keyRule = answerKey
    ? `\n\nThis material's answers are published separately and will be attached afterwards by exact question
number. For every question chunk, set "question_number" to the number PRINTED BESIDE THAT QUESTION in the
excerpt — "6)" means 6, even when it is the first question you emit in this batch. NEVER renumber,
never count positions, never start again from 1. If no number is legibly printed, use null.
Do not write an answer of your own for these questions and do not reason one out; leave answer_status as
"not_in_source" and the answer will be filled in from the official key where one exists.`
    : "";
  // A question bank printed without its answers (and none published to pair
  // with). Rule 3 would skip every question in it; this keeps them. Rule 6 is
  // untouched: the chunker still never writes an answer, and code marks each
  // kept question as having none (QUESTIONS_ONLY_NOTE in ingest.ts).
  const questionsRule = questionsOnly
    ? `\n\nThis source is a past-year question bank printed WITHOUT its answers. Rule 3's skipping does NOT apply
here: emit every exam question as its own "past_year_question" chunk with answer_status "not_in_source",
transcribed in full — every part, option, table and diagram description, in both languages where printed.
Rule 6 still holds absolutely: never write, hint at or reason out an answer. Set "source_note" to the exam
label printed above the question exactly as printed (e.g. "TRIAL KEDAH 2025 – (1)"). A chapter's subtopic
checklist page is one "concept" chunk, kept whole. A bare section heading with nothing under it
("Isotop / Isotope") is not a chunk at all — omit it.
Everything that is not a question is transcribed EXACTLY as printed and nothing is added to it: rule 2
does not apply here, so a printed formula box is emitted as the bare formulas with no explanation, and
you never write a summary, an overview, "key concepts", or a checklist assembled from headings on
different pages. If the page prints no prose, the chunk contains none.`
    : "";
  return `Chunk the following textbook excerpt:${topicRule}${keyRule}${questionsRule}\n\n---\n${batchText}\n---`;
}
