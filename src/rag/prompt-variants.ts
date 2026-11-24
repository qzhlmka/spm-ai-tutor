/**
 * Tutor-prompt variants for answer experiments (rag-stack Phase 5). The live
 * prompt (TUTOR_SYSTEM_PROMPT in chat-handler.ts) is never edited for an
 * experiment; a variant is the live prompt plus a named change, selected with
 * eval-answers --prompt-variant <name>. A variant that wins is then written
 * into the live prompt as its own change.
 */
import { TUTOR_SYSTEM_PROMPT } from "../lib/chat-handler.js";

const ANCHOR = "Grounded does not mean quoted — teach it in your own words.\n";

// p5-grounding-precision (2026-10-13). Run A, judged claim by claim (v3), lost
// faithfulness to two habits: supplying the mechanism/example/value when the
// page only POSES the question or reports an observation (Daniell cell salt
// bridge, candle flame, heat-loss modes, a Teknik U example the notes do not
// have, viscosity, "X-linked" while declining Biology), and refusing to check
// the student's own working ("x - 3 = 5 … x = 2, betul?") although checking
// arithmetic is reasoning the GROUNDING block already permits.
const GROUNDING_PRECISION = `
A PAGE THAT ASKS IS NOT A PAGE THAT ANSWERS. Material often poses a question ("Why is a salt bridge
needed?"), describes an activity, or reports an observation without giving the reason. Then teach what it
does state, and say plainly that the material does not explain why — do not supply the mechanism, cause,
worked example, value or background yourself, however standard it is. The same holds for small additions:
an extra property, a historical detail, a second example the material does not give. Each unsupported
sentence is the failure this rule exists for, even inside an otherwise grounded answer. When you decline
something, decline it without explaining the topic anyway ("that is X-linked inheritance, which…").

THE STUDENT'S OWN WORKING IS ALWAYS CHECKABLE. When a student shows working or an answer and asks whether
it is right, check it, step by step, and point to the exact step that goes wrong. Arithmetic and algebra
are reasoning, not facts, so this never needs a page in the material and is never a reason to decline.
`;

export const PROMPT_VARIANTS: Record<string, string> = {
  live: TUTOR_SYSTEM_PROMPT,
  "grounding-precision": TUTOR_SYSTEM_PROMPT.replace(ANCHOR, ANCHOR + GROUNDING_PRECISION),
};

if (PROMPT_VARIANTS["grounding-precision"] === TUTOR_SYSTEM_PROMPT) throw new Error("prompt-variants: anchor not found in TUTOR_SYSTEM_PROMPT");
