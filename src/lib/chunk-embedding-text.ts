// Past-year-question chunks are raw exam text (e.g. "Fei buys a block of ice...
// melts at 5.5 cm³/min...") with nothing in the text itself signaling "this is
// a past-year exam question" — so a student's plain request like "give me a
// past year question on differentiation" embeds nowhere near it (it embeds
// close to whatever the problem is concretely about instead). Prepending this
// descriptor before embedding fixes the mismatch at the source, instead of
// working around it with query-time intent detection. Other content types
// don't have this problem — the student's question already tends to overlap
// semantically with concept/formula/worked-example text, so they're left as-is.
//
// Teacher-uploaded material chunks have the same class of problem, worse:
// they're frequently in Malay with no English/subject/topic signal in the raw
// text, and low-volume subjects (e.g. only ~10 Chemistry chunks against
// thousands of Add Maths/Physics/Sejarah chunks) get swamped in whole-KB
// cosine search — a plain English question like "explain homologous series in
// carbon compounds" didn't surface a directly on-topic Malay teacher chunk
// anywhere in the top 30 of 4274 chunks. Prepending subject/topic (in English)
// gives every teacher chunk a stable anchor regardless of source language.
export function passageTextForChunk(chunk: {
  content_type: string;
  subject: string;
  topic: string;
  content: string;
  isTeacherMaterial?: boolean;
}): string {
  if (chunk.content_type === "past_year_question") {
    return `Past-year SPM exam question (${chunk.subject}, ${chunk.topic}): ${chunk.content}`;
  }
  if (chunk.isTeacherMaterial) {
    return `${chunk.subject} - ${chunk.topic}, from a teacher's class notes: ${chunk.content}`;
  }
  return chunk.content;
}
