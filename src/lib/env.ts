import "dotenv/config";
import { z } from "zod";

/** Treats a present-but-empty variable ("FOO=" with nothing after it) as absent.
 *
 * This is not a nicety — it is exactly what copying .env.example produces, since
 * that file ships every optional key blank, and both failure modes are caused by
 * the blank line rather than by anything the operator did wrong:
 *
 *  - On a string var, "" fails .min(1)/.url() and .optional() does NOT rescue it
 *    (optional admits undefined, not empty), so env.ts throws at import and the
 *    whole process refuses to boot with a message about a variable the operator
 *    deliberately left unset.
 *  - On a price var the failure is silent and much worse: z.coerce.number()
 *    parses "" as 0 (Number("") === 0), which is a DEFINED rate of zero rather
 *    than a missing one. providers.ts then treats the provider as priced, offers
 *    it to students, and every turn records $0 — so usage_daily never moves and
 *    the daily cap never fires. A blank line in .env silently becomes an
 *    uncapped spend path that looks exactly like a working configuration.
 *
 * Trimming as well as emptiness-checking because a trailing space after the "="
 * is invisible in an editor and would otherwise sail through as a real value. */
const blankIsAbsent = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), schema);

const envSchema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  OPENAI_API_KEY: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1),
  PORT: blankIsAbsent(z.coerce.number().default(3000)),

  // IlmuChat is optional: the app runs without it and simply doesn't offer that
  // provider. All three are needed together — a base URL with no key, or a key
  // with no model, can't produce a request — so providers.ts treats the trio as
  // one unit rather than failing at call time with a confusing 401.
  ILMUCHAT_BASE_URL: blankIsAbsent(z.string().url().optional()),
  ILMUCHAT_API_KEY: blankIsAbsent(z.string().min(1).optional()),
  ILMUCHAT_MODEL: blankIsAbsent(z.string().min(1).optional()),

  // Per-1M-token prices. Optional, but a provider without them is offered to
  // TEACHERS ONLY — see providers.ts. costUsd() returns 0 for a model it has no
  // rate for, and a 0 cost means the student daily cap never triggers, so an
  // unpriced provider open to students is an uncapped spend path that looks
  // like it's working. Teachers are exempt from the cap anyway, so nothing is
  // lost by letting them use it while you find the real numbers.
  ILMUCHAT_PRICE_INPUT_PER_1M: blankIsAbsent(z.coerce.number().nonnegative().optional()),
  ILMUCHAT_PRICE_OUTPUT_PER_1M: blankIsAbsent(z.coerce.number().nonnegative().optional()),
  // Which OpenAI model answers when a user picks GPT. Confirmed present on this
  // account's key via models.list() rather than assumed — "terra" matched
  // exactly one id. Note it is a reasoning model: measured on a full Add Maths
  // turning-point question it spent 349 reasoning tokens out of the 4096
  // max_completion_tokens before writing any answer, so the visible budget is
  // smaller than the cap suggests. It completed comfortably there; raise the cap
  // before assuming it will on longer worked solutions.
  OPENAI_TUTOR_MODEL: blankIsAbsent(z.string().min(1).default("gpt-5.6-terra")),
  OPENAI_PRICE_INPUT_PER_1M: blankIsAbsent(z.coerce.number().nonnegative().optional()),
  OPENAI_PRICE_OUTPUT_PER_1M: blankIsAbsent(z.coerce.number().nonnegative().optional()),

  // Students' daily spend cap in USD (usage.ts). Unset = no cap (turned off
  // 2026-10-16). Positive only: 0 would block every student's first turn.
  STUDENT_DAILY_BUDGET_USD: blankIsAbsent(z.coerce.number().positive().optional()),

  // Langfuse tracing (src/lib/tracing.ts). Optional: with either key missing,
  // tracing is off and every traced call runs exactly as before. The SDK reads
  // these from process.env itself; they are declared here so a typo'd or blank
  // value is treated the same way as every other optional var.
  LANGFUSE_PUBLIC_KEY: blankIsAbsent(z.string().min(1).optional()),
  LANGFUSE_SECRET_KEY: blankIsAbsent(z.string().min(1).optional()),
  LANGFUSE_BASE_URL: blankIsAbsent(z.string().url().optional()),

  // Which table the whole-knowledge-base retrieval lanes read (src/lib/kb-search.ts).
  // content_chunks is the live knowledge base; kb_chunks is the Phase 4 rebuild.
  // Off (content_chunks) until cutover is approved.
  RETRIEVAL_BACKEND: blankIsAbsent(z.enum(["content_chunks", "kb_chunks"]).default("content_chunks")),
});

export const env = envSchema.parse(process.env);
