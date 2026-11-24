// Langfuse tracing, over OpenTelemetry. One trace per chat turn: retrieval
// lanes as a span, and every model call (relevance judge, off-topic
// classifier, diagram locator, visual decision, the answer on any provider) as
// a generation with model, tokens and latency.
//
// Off unless LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are both set. With no
// tracer provider registered the OTel API hands out no-op spans, so every
// traced call below runs unchanged — tracing can never be the reason a turn
// fails.
//
// Initialised on first import rather than in each entry point, so the Fastify
// server, the Vite dev plugin and the CLI scripts all get it without wiring.
// Scripts that end in process.exit() must await flushTracing() first, or the
// batched spans are dropped.
//
// Images are never exported. Requests carry base64 page images and student
// photos; those are replaced with a placeholder before anything is recorded,
// and the processor's own media upload is switched off as a second guard.
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { startActiveObservation } from "@langfuse/tracing";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import type Anthropic from "@anthropic-ai/sdk";
import { anthropic } from "./anthropic.js";
import { env } from "./env.js";

export const tracingEnabled = Boolean(env.LANGFUSE_PUBLIC_KEY && env.LANGFUSE_SECRET_KEY);

let processor: LangfuseSpanProcessor | null = null;
if (tracingEnabled) {
  processor = new LangfuseSpanProcessor({
    mediaUploadEnabled: false,
    environment: process.env.NODE_ENV ?? "development",
    // Last line of defence, applied to EVERY span however it was created —
    // including the ones the LangChain callback handler records for graph
    // nodes, whose outputs (cropped exam pages as data URLs) never pass
    // through redactMedia() at the call site.
    mask: ({ data }) => maskMedia(data),
  });
  new NodeTracerProvider({ spanProcessors: [processor] }).register();
}

export async function flushTracing(): Promise<void> {
  await processor?.forceFlush();
}

/** Deep-copies `value` with every base64 image/document payload replaced. */
export function redactMedia(value: unknown): unknown {
  if (typeof value === "string") {
    return value.startsWith("data:") && value.length > 200 ? `[${value.slice(5, value.indexOf(";"))} omitted]` : value;
  }
  if (Array.isArray(value)) return value.map(redactMedia);
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    // Anthropic image/document block, or OpenAI image_url part.
    if ((o.type === "image" || o.type === "document") && o.source) return { type: o.type, omitted: true };
    if (o.type === "image_url") return { type: "image_url", omitted: true };
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, redactMedia(v)]));
  }
  return value;
}

/** Applies redactMedia to structured data, and strips base64 payloads out of
 * serialized (string) data, which is what spans carry by export time. */
export function maskMedia(data: unknown): unknown {
  if (typeof data === "string") {
    return data
      .replace(/data:[a-z]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]{100,}/gi, "[media omitted]")
      .replace(/"data":\s*"[A-Za-z0-9+/=]{200,}"/g, '"data":"[media omitted]"');
  }
  return redactMedia(data);
}

// Set by usage.ts, which owns the pricing table: the trace records exactly the
// cost the student daily cap is charged, for every provider — Langfuse's own
// model price list has no entry for IlmuChat. Injected rather than imported
// because usage.ts -> providers.ts -> tracing.ts would make a cycle.
type CostFn = (model: string, promptTokens: number, cachedTokens: number, completionTokens: number) => number | null;
let costFn: CostFn | null = null;
export function setTracingCostFn(fn: CostFn): void {
  costFn = fn;
}

export interface GenerationUsage {
  input: number;
  output: number;
  cacheRead?: number;
}

/** Runs one model call as a Langfuse generation. `describe` maps the result to
 * what's recorded; it is only called on success. A throw is recorded on the
 * generation with level ERROR and re-thrown untouched. */
export function traceGeneration<T>(
  name: string,
  attrs: { model: string; input: unknown; modelParameters?: Record<string, string | number> },
  call: () => Promise<T>,
  describe: (result: T) => { output: unknown; usage?: GenerationUsage },
): Promise<T> {
  return startActiveObservation(
    name,
    async (gen) => {
      gen.update({ model: attrs.model, input: redactMedia(attrs.input), modelParameters: attrs.modelParameters });
      try {
        const result = await call();
        const d = describe(result);
        const cost = d.usage ? costFn?.(attrs.model, d.usage.input, d.usage.cacheRead ?? 0, d.usage.output) : null;
        gen.update({
          ...(cost != null ? { costDetails: { total: cost } } : {}),
          output: redactMedia(d.output),
          usageDetails: d.usage
            ? // GenerationUsage.input includes cache reads (that's what costUsd
              // takes); Langfuse sums every key into its total, so report the
              // uncached part as input or cached tokens are counted twice.
              {
                input: d.usage.input - (d.usage.cacheRead ?? 0),
                output: d.usage.output,
                ...(d.usage.cacheRead ? { cache_read_input_tokens: d.usage.cacheRead } : {}),
              }
            : undefined,
        });
        return result;
      } catch (err) {
        gen.update({ level: "ERROR", statusMessage: err instanceof Error ? err.message : String(err) });
        throw err;
      }
    },
    { asType: "generation" },
  );
}

/** Runs `fn` as a plain span (retrieval, a lane, a sub-step). */
export function traceSpan<T>(name: string, input: unknown, fn: () => Promise<T>, describe?: (result: T) => unknown): Promise<T> {
  return startActiveObservation(name, async (span) => {
    span.update({ input: redactMedia(input) });
    try {
      const result = await fn();
      if (describe) span.update({ output: redactMedia(describe(result)) });
      return result;
    } catch (err) {
      span.update({ level: "ERROR", statusMessage: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  });
}

/** Anthropic `message.usage` in the shape traceGeneration records. */
export function anthropicUsage(u: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }): GenerationUsage {
  return {
    input: u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
    output: u.output_tokens,
    cacheRead: u.cache_read_input_tokens ?? 0,
  };
}

/** `anthropic.messages.create` (non-streaming), traced as a generation. Same
 * params, same return value; `name` is what it's called in Langfuse. */
export function tracedMessage(name: string, params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> {
  return traceGeneration(
    name,
    {
      model: params.model,
      input: { system: params.system, messages: params.messages, ...(params.tools ? { tools: params.tools.map((t) => ("name" in t ? t.name : t)) } : {}) },
      modelParameters: { max_tokens: params.max_tokens },
    },
    () => anthropic.messages.create(params),
    (m) => ({ output: m.content, usage: anthropicUsage(m.usage) }),
  );
}
