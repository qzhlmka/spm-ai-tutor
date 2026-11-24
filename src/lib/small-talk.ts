/**
 * Detects a message that is pure greeting/chit-chat with no subject content,
 * so the response doesn't cite "sources" under a reply that taught nothing.
 *
 * WHY THIS EXISTS. Retrieval has no relevance floor for the whole-KB lanes
 * (match_content_chunks returns no `similarity` at all — see the comment on
 * it in schema.sql) and runs on every non-empty question, "hi" included. It
 * always returns its 5 nearest chunks, nearest being a relative notion with
 * no floor under it, and chat-handler.ts used to echo that list straight into
 * the response's `sources` field regardless of whether the reply used any of
 * it. Reported: a plain "hi" showed a "Sources (n)" toggle in the UI.
 *
 * The fix is narrow on purpose: it decides whether to SHOW sources, not
 * whether to retrieve. Retrieval, context-building, the teacher-material
 * judge and the model call are all untouched, so a message this misjudges
 * only costs a wrongly-hidden (never wrongly-shown) sources list.
 *
 * Matching requires EVERY word in the message to be in the closed set below.
 * That is deliberately conservative: "how are you" is all set-membership, but
 * "how are lenses formed" is not ("lenses", "formed" aren't in the set), so a
 * real short question is never misclassified just for overlapping a couple
 * of common words with a greeting. An unrecognised word means "not small
 * talk" — the same degrade-safely rule the reply-language and glossary
 * lookups already use.
 */

const SMALL_TALK_WORDS = new Set(
  (
    // English
    "hi hello hey hiya yo sup morning afternoon evening good great greetings " +
      "thanks thank you thankyou ok okay alright cool nice bye goodbye see later " +
      "test testing hows how are going there u r yes yeah yep nope no k kk lol " +
      "haha hmm sorry please welcome " +
      // Malay / Manglish
      "hai helo apa khabar khabarnya awak ok okey okla baik selamat pagi tengahari " +
      "petang malam terima kasih tq tqvm bye2 assalamualaikum salam wsalam " +
      "sihat tak x ye eh oh ala haa hah"
  ).split(" "),
);

export function isSmallTalk(question: string): boolean {
  const words = question.toLowerCase().match(/[a-z]+/g);
  if (!words || words.length === 0) return false;
  return words.every((w) => SMALL_TALK_WORDS.has(w));
}
