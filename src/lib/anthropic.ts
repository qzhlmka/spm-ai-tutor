import Anthropic from "@anthropic-ai/sdk";
import { env } from "./env.js";

export const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

// Handles all chat-handler.ts model calls: the main tutoring answer (text and
// image/PDF attachments alike — Sonnet 5 supports vision natively), the teacher
// -material relevance gate, and the visual-diagram tool-call decision (via
// ANTHROPIC_VISUAL_TOOLS in visual.ts). OpenAI (src/lib/openai.ts) is only used
// for ingestion (CHUNKING_MODEL), not any live chat request.
//
// History: this path was moved off gpt-5.4 to claude-haiku-4-5 after a
// side-by-side comparison on real SPM questions — matched content quality, ~2x
// faster, ~40% of the per-token cost, and correctly declined an off-topic
// "write my essay" request that gpt-5.4 answered in violation of
// TUTOR_SYSTEM_PROMPT's scope rule. Now on Sonnet 5 for answer quality.
//
// Sonnet 5 runs ADAPTIVE THINKING when the `thinking` parameter is omitted,
// unlike Haiku 4.5 which never thought. Every call site in chat-handler.ts
// therefore passes `thinking: { type: "disabled" }` explicitly — see the
// comments there for why each one needs it. Do not drop those without also
// raising that call's max_tokens, since thinking tokens are billed against it.
export const TUTOR_MODEL = "claude-sonnet-5";
