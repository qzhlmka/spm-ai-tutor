/**
 * The three LLM providers a student can pick between for the tutoring answer,
 * behind one call signature.
 *
 * SCOPE. Only the main tutoring answer follows the choice. The teacher-material
 * relevance gate and the visual-diagram decision stay on Anthropic, deliberately:
 * both are forced tool calls, their schemas are in Anthropic's tool format, and
 * the gate is written to fail CLOSED. Routing it through a provider whose
 * forced-tool-call behaviour hasn't been verified would degrade teacher-material
 * retrieval on every request, silently, in a way no student could see. Porting
 * them is a separate job with its own verification, not a config flag.
 *
 * SHAPE. Anthropic needs its own client. OpenAI and IlmuChat are both reached
 * through the `openai` SDK — IlmuChat exposes an OpenAI-compatible
 * /v1/chat/completions, so it is the same code with a different baseURL and key.
 * That is why `kind` is "openai-compatible" rather than "openai": the branch is
 * about wire format, not about vendor.
 *
 * PRICING IS A SAFETY GATE, NOT A NICETY. `costUsd()` in usage.ts is keyed by
 * model string and returns 0 for a model it doesn't know. A 0 cost never moves
 * usage_daily, so the student daily cap never fires — an unpriced provider open
 * to students is an uncapped spend path that looks exactly like a working one.
 * This session already hit that once when TUTOR_MODEL changed and the pricing
 * key didn't. So a provider with no configured rates is offered to TEACHERS
 * ONLY. Teachers are exempt from the cap regardless, so nothing is lost, and the
 * restriction lifts by setting two env vars.
 */
import type Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { TUTOR_MODEL } from "./anthropic.js";
import { traceGeneration, tracedMessage } from "./tracing.js";
import { openai } from "./openai.js";
import { env } from "./env.js";

export const PROVIDER_IDS = ["anthropic", "openai", "ilmuchat"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === "string" && (PROVIDER_IDS as readonly string[]).includes(value);
}

/** What the tutor falls back to when a conversation names no provider — every
 * conversation that predates this feature, and every new one until the student
 * touches the picker. Anthropic because it is the one path whose scope
 * compliance, vision handling and cost are all measured (see anthropic.ts). */
export const DEFAULT_PROVIDER: ProviderId = "anthropic";

export interface ProviderPricing {
  input: number;
  cachedInput: number;
  output: number;
}

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  model: string;
  /** False when the deployment has no credentials for it — the picker hides it
   * rather than offering a button that 500s. */
  configured: boolean;
  /** True when it may be offered to students. See the pricing note above. */
  availableToStudents: boolean;
  /** Shown in the UI when a teacher sees a provider students cannot use. */
  note: string | null;
}

interface ProviderConfig extends ProviderInfo {
  kind: "anthropic" | "openai-compatible";
  /** Null for the Anthropic provider, which uses its own client. */
  client: OpenAI | null;
  pricing: ProviderPricing | null;
}

/** Published per-1M-token rates for models this repo has actually checked, so a
 * known model needs no env configuration to be safe for students.
 *
 * STANDARD TIER ONLY. Batch, Flex and Fast are all priced differently and this
 * app uses none of them. Terra also has a long-context tier — over 272K input
 * tokens it moves to $4/$18 — which these numbers ignore because a turn here is
 * a ~2.3k system prompt plus at most 12 retrieved chunks, orders of magnitude
 * below that. If retrieval ever grows to send six-figure token counts, this
 * table understates the bill and the cap with it.
 *
 * An env override always wins, which is how you correct a rate change without a
 * deploy, and how an unlisted model becomes usable by students at all.
 * Anthropic's rates: see src/lib/anthropic.ts. OpenAI's checked against
 * developers.openai.com/api/docs/pricing and corroborated separately, 2026-09. */
const KNOWN_MODEL_PRICING: Record<string, ProviderPricing> = {
  "claude-sonnet-5": { input: 2, cachedInput: 0.2, output: 10 },
  "gpt-5.6-terra": { input: 2, cachedInput: 0.2, output: 12 },
  "gpt-5.6-sol": { input: 4, cachedInput: 0.4, output: 20 },
  "gpt-5.6-luna": { input: 0.2, cachedInput: 0.02, output: 1.2 },
  "gpt-6-astra": { input: 10, cachedInput: 1, output: 50 },
};

/** Env override first, then the checked table, then nothing — and "nothing"
 * means teacher-only, not free. The override carries no cached rate of its own,
 * so it bills cached input at the full rate: an over-count, which is the safe
 * direction for a spend cap. */
function pricingFor(
  model: string,
  overrideInput: number | undefined,
  overrideOutput: number | undefined,
): ProviderPricing | null {
  if (overrideInput !== undefined && overrideOutput !== undefined) {
    return { input: overrideInput, cachedInput: overrideInput, output: overrideOutput };
  }
  return KNOWN_MODEL_PRICING[model] ?? null;
}

/** Built once at module load. A lazy singleton would re-read env on every call
 * for no benefit — env.ts already validated and froze it at startup. */
const CONFIGS: Record<ProviderId, ProviderConfig> = buildConfigs();

function buildConfigs(): Record<ProviderId, ProviderConfig> {
  // Anthropic: always configured (ANTHROPIC_API_KEY is required by env.ts) and
  // always priced, since usage.ts carries the rates for TUTOR_MODEL.
  const anthropicConfig: ProviderConfig = {
    id: "anthropic",
    label: "Claude",
    model: TUTOR_MODEL,
    kind: "anthropic",
    client: null,
    configured: true,
    availableToStudents: true,
    note: null,
    pricing: pricingFor(TUTOR_MODEL, undefined, undefined),
  };

  const openaiPricing = pricingFor(
    env.OPENAI_TUTOR_MODEL,
    env.OPENAI_PRICE_INPUT_PER_1M,
    env.OPENAI_PRICE_OUTPUT_PER_1M,
  );
  const openaiConfig: ProviderConfig = {
    id: "openai",
    label: "GPT",
    model: env.OPENAI_TUTOR_MODEL,
    kind: "openai-compatible",
    client: openai,
    configured: true, // OPENAI_API_KEY is required by env.ts for ingestion anyway
    availableToStudents: openaiPricing !== null,
    note:
      openaiPricing === null
        ? `Teachers only: no published rate is recorded for ${env.OPENAI_TUTOR_MODEL}. Set OPENAI_PRICE_INPUT_PER_1M and OPENAI_PRICE_OUTPUT_PER_1M — without them the student spend cap can't count this.`
        : null,
    pricing: openaiPricing,
  };

  const ilmuConfigured = Boolean(env.ILMUCHAT_BASE_URL && env.ILMUCHAT_API_KEY && env.ILMUCHAT_MODEL);
  const ilmuPricing = pricingFor(
    env.ILMUCHAT_MODEL ?? "",
    env.ILMUCHAT_PRICE_INPUT_PER_1M,
    env.ILMUCHAT_PRICE_OUTPUT_PER_1M,
  );
  const ilmuConfig: ProviderConfig = {
    id: "ilmuchat",
    label: "IlmuChat",
    model: env.ILMUCHAT_MODEL ?? "(not configured)",
    kind: "openai-compatible",
    client: ilmuConfigured
      ? new OpenAI({ apiKey: env.ILMUCHAT_API_KEY, baseURL: env.ILMUCHAT_BASE_URL })
      : null,
    configured: ilmuConfigured,
    availableToStudents: ilmuConfigured && ilmuPricing !== null,
    note: !ilmuConfigured
      ? "Not configured — set ILMUCHAT_BASE_URL, ILMUCHAT_API_KEY and ILMUCHAT_MODEL."
      : ilmuPricing === null
        ? "Teachers only until ILMUCHAT_PRICE_INPUT_PER_1M and ILMUCHAT_PRICE_OUTPUT_PER_1M are set — without rates the student spend cap can't count this."
        : null,
    pricing: ilmuPricing,
  };

  return { anthropic: anthropicConfig, openai: openaiConfig, ilmuchat: ilmuConfig };
}

/** Per-model rates for usage.ts, so the spend cap counts whichever provider ran.
 * Keyed by model string because that is what recordUsage() is given. */
export function providerPricingByModel(): Record<string, ProviderPricing> {
  const table: Record<string, ProviderPricing> = {};
  for (const id of PROVIDER_IDS) {
    const c = CONFIGS[id];
    if (c.pricing) table[c.model] = c.pricing;
  }
  return table;
}

/** What the picker should show this user. Unconfigured providers are left out
 * entirely; ones that are teacher-only are included for teachers with a note. */
export function listProviders(role: "student" | "teacher"): ProviderInfo[] {
  return PROVIDER_IDS.map((id) => CONFIGS[id])
    .filter((c) => c.configured && (role === "teacher" || c.availableToStudents))
    .map(({ id, label, model, configured, availableToStudents, note }) => ({
      id,
      label,
      model,
      configured,
      availableToStudents,
      note,
    }));
}

/** Resolves a requested provider to one that may actually run for this user.
 *
 * Falls back rather than erroring: a conversation can name a provider that was
 * later unconfigured, or a student can inherit a teacher-only choice from a
 * shared link, and neither should turn into a failed turn. The caller is told
 * which one actually ran so the UI never claims the wrong thing. */
export function resolveProvider(
  requested: ProviderId | null | undefined,
  role: "student" | "teacher",
): { id: ProviderId; model: string; fellBack: boolean } {
  const wanted = requested && isProviderId(requested) ? CONFIGS[requested] : null;
  const usable =
    wanted && wanted.configured && (role === "teacher" || wanted.availableToStudents) ? wanted : null;
  const chosen = usable ?? CONFIGS[DEFAULT_PROVIDER];
  return { id: chosen.id, model: chosen.model, fellBack: chosen.id !== requested && Boolean(requested) };
}

export interface TutorTurn {
  system: string;
  history: { role: "user" | "assistant"; content: string }[];
  /** The current question, already assembled with its context block. */
  question: string;
  /** Student attachments, in Anthropic's block shape — converted per provider. */
  images: Anthropic.ImageBlockParam[];
  maxTokens: number;
}

export interface TutorAnswer {
  text: string;
  model: string;
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
}

/** One call, whichever provider is selected. */
export async function generateTutorAnswer(providerId: ProviderId, turn: TutorTurn): Promise<TutorAnswer> {
  const config = CONFIGS[providerId];
  if (!config.configured) throw new Error(`provider ${providerId} is not configured`);
  return config.kind === "anthropic" ? runAnthropic(turn) : runOpenAiCompatible(config, turn);
}

async function runAnthropic(turn: TutorTurn): Promise<TutorAnswer> {
  const userContent: Anthropic.MessageParam["content"] =
    turn.images.length > 0
      ? [...turn.images, { type: "text" as const, text: turn.question }]
      : turn.question;

  const message = await tracedMessage("tutor-answer", {
    model: TUTOR_MODEL,
    max_tokens: turn.maxTokens,
    // Sonnet 5 thinks by default when this is omitted; thinking tokens bill
    // against max_tokens and would truncate long worked solutions. See
    // anthropic.ts for the full reasoning.
    thinking: { type: "disabled" as const },
    system: [{ type: "text", text: turn.system, cache_control: { type: "ephemeral" } }],
    messages: [...turn.history, { role: "user" as const, content: userContent }],
  });

  return {
    text: message.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n"),
    model: TUTOR_MODEL,
    promptTokens:
      message.usage.input_tokens +
      (message.usage.cache_creation_input_tokens ?? 0) +
      (message.usage.cache_read_input_tokens ?? 0),
    cachedTokens: message.usage.cache_read_input_tokens ?? 0,
    completionTokens: message.usage.output_tokens,
  };
}

async function runOpenAiCompatible(config: ProviderConfig, turn: TutorTurn): Promise<TutorAnswer> {
  if (!config.client) throw new Error(`provider ${config.id} has no client`);

  // Anthropic carries an image as base64 + media_type in its own block; the
  // chat-completions format wants a data: URL. Converting here rather than
  // making attachments.ts emit both shapes keeps one source of truth for what
  // an attachment IS, with the wire format as a per-provider detail.
  const userContent: OpenAI.Chat.Completions.ChatCompletionContentPart[] =
    turn.images.length > 0
      ? [
          ...turn.images.map((img) => {
            const source = img.source as { type: string; media_type: string; data: string };
            return {
              type: "image_url" as const,
              image_url: { url: `data:${source.media_type};base64,${source.data}` },
            };
          }),
          { type: "text" as const, text: turn.question },
        ]
      : [{ type: "text" as const, text: turn.question }];

  const client = config.client;
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: turn.system },
    ...turn.history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: userContent },
  ];
  const completion = await traceGeneration(
    "tutor-answer",
    { model: config.model, input: { provider: config.id, messages }, modelParameters: { max_completion_tokens: turn.maxTokens } },
    () => client.chat.completions.create({ model: config.model, max_completion_tokens: turn.maxTokens, messages }),
    (c) => ({
      output: c.choices[0]?.message?.content ?? "",
      usage: {
        input: c.usage?.prompt_tokens ?? 0,
        output: c.usage?.completion_tokens ?? 0,
        cacheRead: c.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      },
    }),
  );

  const usage = completion.usage;
  return {
    text: completion.choices[0]?.message?.content ?? "",
    model: config.model,
    promptTokens: usage?.prompt_tokens ?? 0,
    // Present on OpenAI; an OpenAI-compatible server may omit it, in which case
    // nothing is treated as cached and the turn is costed at the full rate.
    cachedTokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
    completionTokens: usage?.completion_tokens ?? 0,
  };
}
