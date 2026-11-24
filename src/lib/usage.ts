import { supabase } from "./supabase.js";
import { providerPricingByModel } from "./providers.js";
import type { AuthedUser } from "./auth.js";
import { setTracingCostFn } from "./tracing.js";
import { env } from "./env.js";

// Only students are capped — teachers use the platform to prepare/verify
// material, not as a student's per-turn budget, so they're exempt entirely.
// Off unless STUDENT_DAILY_BUDGET_USD is set (it was a fixed $0.20 until
// 2026-10-16). Spend is still recorded either way, so turning the cap back on
// needs only the env var.
export const STUDENT_DAILY_BUDGET_USD: number | null = env.STUDENT_DAILY_BUDGET_USD ?? null;

// Per-1M-token USD pricing, keyed by MODEL STRING because that is what
// recordUsage() is handed. The rates come from providers.ts so that adding a
// provider cannot leave a hole here — this table and the provider list are one
// definition, not two that drift.
//
// The hole matters: costUsd() returns 0 for a model it has no rate for, a 0
// cost never moves usage_daily, and a student whose turns cost nothing never
// hits the daily cap. That is an uncapped spend path that looks exactly like a
// working one, and it is why providers.ts offers an unpriced provider to
// teachers only (who are exempt from the cap anyway). Confirmed against
// Anthropic's published pricing 2026-09; the OpenAI and IlmuChat rates are
// whatever the deployment sets in env, since neither is fixed here.
const PRICING_PER_1M_TOKENS: Record<string, { input: number; cachedInput: number; output: number }> =
  providerPricingByModel();

// TUTOR_SYSTEM_PROMPT (chat-handler.ts) is marked with cache_control. Under
// claude-haiku-4-5 this was a measured no-op — that model needs >=4096 tokens in a
// block before caching engages and the prompt is only ~2.2-2.3k — so every request
// billed at the full input rate. The minimum cacheable prefix is model-dependent, so
// re-check cache_read_input_tokens on a repeat question now that the model changed;
// this function already handles the cached case correctly either way.
// Cache writes are folded into the full-price bucket rather than given their own pricing
// tier — a minor conservative overcount on cache-write turns, not worth the complexity.
function costUsd(model: string, promptTokens: number, cachedTokens: number, completionTokens: number): number {
  const rate = PRICING_PER_1M_TOKENS[model];
  if (!rate) return 0;
  const uncachedPromptTokens = Math.max(0, promptTokens - cachedTokens);
  return (
    (uncachedPromptTokens / 1_000_000) * rate.input +
    (cachedTokens / 1_000_000) * rate.cachedInput +
    (completionTokens / 1_000_000) * rate.output
  );
}

// Unpriced models report no cost rather than $0, so a missing rate shows as a
// gap in Langfuse instead of looking free.
setTracingCostFn((model, prompt, cached, completion) =>
  PRICING_PER_1M_TOKENS[model] ? costUsd(model, prompt, cached, completion) : null,
);

function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function getTodayUsageUsd(userId: string): Promise<number> {
  const { data, error } = await supabase
    .from("usage_daily")
    .select("cost_usd")
    .eq("user_id", userId)
    .eq("usage_date", todayDate())
    .maybeSingle();
  if (error) {
    console.error("failed to read usage_daily", error);
    return 0;
  }
  return data?.cost_usd ?? 0;
}

export interface UsageLimitCheck {
  allowed: boolean;
  usedUsd: number;
  limitUsd: number | null;
}

/** Students are blocked once today's spend reaches the daily budget; teachers
 * always pass. Call before doing any model work for the turn. */
export async function checkUsageLimit(user: AuthedUser): Promise<UsageLimitCheck> {
  if (user.role !== "student" || STUDENT_DAILY_BUDGET_USD === null) {
    return { allowed: true, usedUsd: 0, limitUsd: STUDENT_DAILY_BUDGET_USD };
  }
  const usedUsd = await getTodayUsageUsd(user.id);
  return { allowed: usedUsd < STUDENT_DAILY_BUDGET_USD, usedUsd, limitUsd: STUDENT_DAILY_BUDGET_USD };
}

/** Records actual token spend for a completion call — call once per OpenAI
 * request (chat-handler.ts makes up to two: the main answer and the visual
 * tool-call decision), regardless of role, so teacher usage is still visible
 * in usage_daily even though it's never enforced. */
export async function recordUsage(
  userId: string,
  model: string,
  promptTokens: number,
  cachedTokens: number,
  completionTokens: number,
): Promise<void> {
  const cost = costUsd(model, promptTokens, cachedTokens, completionTokens);
  if (cost <= 0) return;
  const { error } = await supabase.rpc("increment_usage", {
    p_user_id: userId,
    p_usage_date: todayDate(),
    p_cost_usd: cost,
  });
  if (error) {
    console.error("failed to record usage", error);
  }
}
