/**
 * Tests whether a question file's numbering actually lines up with a separate
 * answer key, before any of that key is written to the database.
 *
 * Needed because pairing on (chapter, question number) silently succeeds against
 * the WRONG file: a teacher's worksheet on the same chapter numbers its questions
 * from 1 just like the printed module does. Checking a stored answer against the
 * key it came from cannot detect this — it is circular. Only the question's
 * meaning can.
 *
 * So each sampled question is shown to a model together with the key's proposed
 * answer, and the model judges whether that answer is correct. The model never
 * supplies an answer that gets stored; it only scores a hypothesis. A correctly
 * aligned file scores near 100%, a misaligned one near 25% (chance on 4 options),
 * and those are far enough apart to separate reliably — unlike every
 * content-similarity heuristic tried earlier in this project.
 */
import { openai, CHUNKING_MODEL } from "../lib/openai.js";

export interface AlignmentResult {
  sampled: number;
  agreed: number;
  rate: number;
  disagreements: string[];
}

/** Pulls numbered multiple-choice questions out of an OCR'd page set. */
export function extractMcqs(pages: string[]): { num: number; text: string }[] {
  const text = pages.join("\n");
  const out: { num: number; text: string }[] = [];
  // A question runs from its number to the next number that is followed by
  // options — anchoring on the presence of an "A." ... "D." block is what keeps
  // list items and marks annotations from being read as questions.
  const re = /(?:^|\n)\s*(\d{1,2})[\.\)]\s+([\s\S]{40,1600}?)(?=\n\s*\d{1,2}[\.\)]\s+|$)/g;
  for (const m of text.matchAll(re)) {
    const body = m[2];
    if (!/(?:^|\n)\s*A[\.\)\s]/.test(body) || !/(?:^|\n)\s*D[\.\)\s]/.test(body)) continue;
    out.push({ num: Number(m[1]), text: body.trim().slice(0, 1200) });
  }
  return out;
}

export async function validateAlignment(
  mcqs: { num: number; text: string }[],
  key: Map<number, string>,
  sampleSize = 10,
): Promise<AlignmentResult> {
  const candidates = mcqs.filter((q) => key.has(q.num));
  // Spread the sample across the file rather than taking the first N — a file can
  // begin with the module's pages and continue into unrelated worksheet pages.
  const step = Math.max(1, Math.floor(candidates.length / sampleSize));
  const sample = candidates.filter((_, i) => i % step === 0).slice(0, sampleSize);

  let agreed = 0;
  const disagreements: string[] = [];
  for (const q of sample) {
    const proposed = key.get(q.num)!;
    const r = await openai.chat.completions.create({
      model: CHUNKING_MODEL,
      temperature: 0,
      messages: [
        {
          role: "system",
          content:
            "You check Malaysian SPM Chemistry multiple-choice answers. You are given a question and a " +
            "PROPOSED answer letter. Decide whether that letter is the correct option. Work it out from the " +
            "chemistry, not from any assumption that the proposal is right — it is often wrong. " +
            'Reply with JSON only: {"correct": true|false, "should_be": "<letter or null>"}.',
        },
        { role: "user", content: `QUESTION:\n${q.text}\n\nPROPOSED ANSWER: ${proposed}` },
      ],
      response_format: { type: "json_object" },
    });
    const v = JSON.parse(r.choices[0]?.message?.content ?? "{}");
    if (v.correct === true) agreed++;
    else if (disagreements.length < 4) disagreements.push(`Q${q.num}: key says ${proposed}, judged ${v.should_be ?? "?"}`);
  }
  return { sampled: sample.length, agreed, rate: sample.length ? agreed / sample.length : 0, disagreements };
}
