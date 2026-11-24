/**
 * The topology of one chat turn, as a LangGraph StateGraph. This file owns the
 * SHAPE — which step follows which, what runs in parallel, where it can stop —
 * and nothing else. The steps themselves are passed in (`ChatNodes`) from
 * chat-handler.ts, which holds the retrieval gates, prompts and cutoffs they
 * depend on; keeping them there avoids a runtime import cycle and keeps this
 * file readable as a diagram. (A node may not share a name with a state
 * channel, hence routeDecision / materialsResult / visualResult.)
 *
 *   START → route ─┬─(catalogue)───────► resources + catalogue ─┐
 *                  ├─(conversational)──────────────► resources ─┤
 *                  └─(schoolwork)─► retrieve ─┬─(failed)─► END    │
 *                                             └─► exam_images ────┤
 *                                             └─► materials ──────┤
 *                                             └─► resources ──────┤
 *                                                                 ▼
 *   compose → provider → generate → persist → visual → END
 *
 * exam_images, materials and resources only read what retrieval produced and
 * never each other's output, so they run as one parallel step.
 */
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { startActiveObservation } from "@langfuse/tracing";
import type { RouteDecision } from "./router.js";
import type { ProviderId } from "./providers.js";
import type { MaterialLookup } from "./material-lookup.js";
import type { ExamImagesResult, MaterialsResult, RetrievalOutcome, TurnVisual } from "./chat-handler.js";

const field = <T>(initial: T) => Annotation<T>({ reducer: (_prev, next) => next, default: () => initial });

export const TurnAnnotation = Annotation.Root({
  routeDecision: field<RouteDecision | null>(null),
  // The message rewritten to stand on its own (standalone-question.ts); null on a
  // first message, a self-contained one, or a failed rewrite.
  standalone: field<string | null>(null),
  // The teacher files the student asked for (material-lookup.ts); null when the
  // message is not a file request.
  fileRequest: field<MaterialLookup | null>(null),
  conversational: field(false),
  retrieval: field<RetrievalOutcome | null>(null),
  retrievalFailed: field(false),
  examImages: field<ExamImagesResult | null>(null),
  materialsResult: field<MaterialsResult | null>(null),
  resourceNote: field(""),
  catalogueNote: field(""),
  context: field(""),
  questionText: field(""),
  activeProvider: field<ProviderId | null>(null),
  answer: field(""),
  answeredBy: field<ProviderId | null>(null),
  visualResult: field<TurnVisual>(null),
});

export type TurnState = typeof TurnAnnotation.State;
export type NodeFn = (state: TurnState) => Promise<Partial<TurnState>> | Partial<TurnState>;

export const CHAT_NODE_NAMES = [
  "route",
  "retrieve",
  "exam_images",
  "materials",
  "resources",
  "catalogue",
  "compose",
  "provider",
  "generate",
  "persist",
  "visual",
] as const;
export type ChatNodes = Record<(typeof CHAT_NODE_NAMES)[number], NodeFn>;

/** Superstep each node runs in, for the trace. The three enrichment nodes share one. */
const STEP: Record<(typeof CHAT_NODE_NAMES)[number], number> = {
  route: 1,
  retrieve: 2,
  exam_images: 3,
  materials: 3,
  resources: 3,
  catalogue: 2,
  compose: 4,
  provider: 5,
  generate: 6,
  persist: 7,
  visual: 8,
};

/** What a node wrote, without the content: a trace of key -> size, so the span
 * shows what the step produced without copying chunk text, prompts or base64
 * page images into Langfuse. */
function describeWrite(update: Partial<TurnState>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(update)) {
    out[key] =
      typeof value === "string"
        ? `${value.length} chars`
        : Array.isArray(value)
          ? `${value.length} items`
          : value && typeof value === "object"
            ? Object.keys(value)
            : value;
  }
  return out;
}

/** Each node is one Langfuse observation, active while it runs — so the spans
 * the step opens itself (embeddings, lanes, model calls) nest inside it, and
 * `langgraph_node` / `langgraph_step` mark it as a graph node. */
function traced(name: (typeof CHAT_NODE_NAMES)[number], fn: NodeFn): NodeFn {
  return (state) =>
    startActiveObservation(
      name,
      async (span) => {
        span.update({ metadata: { langgraph_node: name, langgraph_step: STEP[name] } });
        const update = await fn(state);
        span.update({ output: describeWrite(update) });
        return update;
      },
      { asType: "chain" },
    );
}

export function buildChatGraph(n: ChatNodes) {
  return new StateGraph(TurnAnnotation)
    .addNode("route", traced("route", n.route))
    .addNode("retrieve", traced("retrieve", n.retrieve))
    .addNode("exam_images", traced("exam_images", n.exam_images))
    .addNode("materials", traced("materials", n.materials))
    .addNode("resources", traced("resources", n.resources))
    .addNode("catalogue", traced("catalogue", n.catalogue))
    .addNode("compose", traced("compose", n.compose))
    .addNode("provider", traced("provider", n.provider))
    .addNode("generate", traced("generate", n.generate))
    .addNode("persist", traced("persist", n.persist))
    .addNode("visual", traced("visual", n.visual))
    .addEdge(START, "route")
    // A conversational turn skips retrieval and everything that reads it. It
    // still loads the teacher link catalogue, which the prompt has always
    // carried on every turn.
    // A catalogue question ("what topics do you have") is answered from the
    // database's own subject/topic list, not from retrieval, which can only
    // ever see a handful of chunks and was miscounting from them.
    .addConditionalEdges(
      "route",
      (s) =>
        s.routeDecision?.route === "catalogue" && s.conversational
          ? ["resources", "catalogue"]
          : s.conversational
            ? ["resources"]
            : ["retrieve"],
      ["resources", "catalogue", "retrieve"],
    )
    .addConditionalEdges(
      "retrieve",
      (s) => (s.retrievalFailed ? [END] : ["exam_images", "materials", "resources"]),
      [END, "exam_images", "materials", "resources"],
    )
    .addEdge("exam_images", "compose")
    .addEdge("materials", "compose")
    .addEdge("resources", "compose")
    .addEdge("catalogue", "compose")
    .addEdge("compose", "provider")
    .addEdge("provider", "generate")
    .addEdge("generate", "persist")
    .addEdge("persist", "visual")
    .addEdge("visual", END)
    .compile();
}

/** Mermaid source for the turn graph — `npm run router:graph`. */
export function chatGraphMermaid(): string {
  const stub = () => ({});
  const nodes = Object.fromEntries(CHAT_NODE_NAMES.map((name) => [name, stub])) as unknown as ChatNodes;
  return buildChatGraph(nodes).getGraph().drawMermaid();
}
