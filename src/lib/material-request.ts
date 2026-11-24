/** A bare confirmation ("yes", "sure", "boleh", "ok please"), which the router
 * sends to the material pipeline rather than filing as small talk. (It used to
 * confirm an offered file; since 2026-10-19 relevant files are listed in the
 * Files panel without asking.) Same all-words-in-a-closed-set
 * requirement as isSmallTalk in small-talk.ts, for the same reason: a real
 * question sharing a word or two with this set ("how do I balance this")
 * still fails the ALL-words check because its content words aren't in it. */
const AFFIRMATIVE_WORDS = new Set(
  (
    "yes yeah yeh yep yup sure ok okay please pls plz do go ahead it them the " +
      "notes note file pdf material now want share attach send " +
      "ya boleh nak eh la je tolong sila hantar hantarkan kongsi baik ye"
  ).split(" "),
);

export function isAffirmativeReply(question: string): boolean {
  const words = question.toLowerCase().match(/[a-z]+/g);
  if (!words || words.length === 0) return false;
  const hasAffirmation = words.some((w) => ["yes", "yeah", "yeh", "yep", "yup", "sure", "ok", "okay", "ya", "boleh", "baik"].includes(w));
  return hasAffirmation && words.every((w) => AFFIRMATIVE_WORDS.has(w));
}
