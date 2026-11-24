import type { ChatCompletionTool } from "openai/resources/chat/completions";
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

const range = z.tuple([z.number(), z.number()]).refine(([a, b]) => a < b, "min must be below max");

// The model chooses WHAT to plot; every coordinate shown on the graph is
// computed by the renderer from the expressions (frontend/src/lib/graphAnalysis.ts).
// That is why a marked point carries only x: its y is read off the curve, so a
// label can't sit on a point the line doesn't pass through.
const functionVisualSchema = z.object({
  type: z.literal("function"),
  curves: z
    .array(z.object({ expr: z.string().min(1).max(200), label: z.string().max(60).optional() }))
    .min(1)
    .max(4),
  domain: range.optional(),
  yRange: range.optional(),
  angleUnit: z.enum(["radians", "degrees"]).optional(),
  shade: z
    .object({
      from: z.number(),
      to: z.number(),
      curve: z.number().int().min(0).optional(),
      between: z.number().int().min(0).optional(),
    })
    .optional(),
  points: z
    .array(z.object({ x: z.number(), curve: z.number().int().min(0).optional(), label: z.string().max(40).optional() }))
    .max(6)
    .optional(),
  label: z.string().optional(),
});

const triangleVisualSchema = z.object({
  type: z.literal("triangle"),
  sides: z
    .object({
      a: z.number().nullable().optional(),
      b: z.number().nullable().optional(),
      c: z.number().nullable().optional(),
    })
    .optional(),
  angles: z
    .object({
      A: z.number().nullable().optional(),
      B: z.number().nullable().optional(),
      C: z.number().nullable().optional(),
    })
    .optional(),
  label: z.string().optional(),
});

const vectorVisualSchema = z.object({
  type: z.literal("vector"),
  vectors: z
    .array(
      z.object({
        label: z.string(),
        x: z.number(),
        y: z.number(),
      })
    )
    .min(1),
  label: z.string().optional(),
});

export const visualSchema = z.discriminatedUnion("type", [
  functionVisualSchema,
  triangleVisualSchema,
  vectorVisualSchema,
]);

export type Visual = z.infer<typeof visualSchema>;

const VISUAL_TOOLS_BY_NAME: Record<string, ChatCompletionTool> = {
  plot_function: {
    type: "function",
    function: {
      name: "plot_function",
      description:
        "Plot one or more function graphs on the same axes. Intercepts, turning points and intersections are found and labelled automatically from the expressions, exactly — do not compute or pass them.",
      parameters: {
        type: "object",
        properties: {
          curves: {
            type: "array",
            minItems: 1,
            maxItems: 4,
            description: "The curves to draw on the same axes, e.g. a curve and a straight line whose intersection is asked for.",
            items: {
              type: "object",
              properties: {
                expr: {
                  type: "string",
                  description:
                    'The function in terms of x, e.g. "x^2 - 4x + 3", "2sin(x) + 1", "3^x", "log(x)". Supports + - * / ^, brackets, implicit multiplication, pi, and sin cos tan sqrt abs exp, log (base 10) and ln (base e). Function arguments always in brackets: sin(2x), never sin 2x.',
                },
                label: { type: "string", description: 'How the curve is named in the legend, e.g. "y = x² − 4x + 3".' },
              },
              required: ["expr"],
            },
          },
          domain: {
            type: "array",
            items: { type: "number" },
            minItems: 2,
            maxItems: 2,
            description:
              "The [min, max] x-range. Use the range the question states (e.g. 0 to 2*pi, or 0 to 360 in degrees); otherwise one that shows every root and turning point with a little margin.",
          },
          yRange: {
            type: "array",
            items: { type: "number" },
            minItems: 2,
            maxItems: 2,
            description: "Optional [min, max] y-range. Leave it out unless the question fixes one; a sensible window is chosen automatically.",
          },
          angleUnit: {
            type: "string",
            enum: ["radians", "degrees"],
            description: "For trigonometric graphs: whether x is in radians (default) or degrees, as in the question.",
          },
          shade: {
            type: "object",
            description:
              "Optional region to shade, for an area question (Integration). Shades between curve `curve` and the x-axis, or between curves `curve` and `between`, from x = from to x = to.",
            properties: {
              from: { type: "number" },
              to: { type: "number" },
              curve: { type: "integer", description: "Index into curves (default 0)." },
              between: { type: "integer", description: "Index of a second curve, to shade the region between two curves." },
            },
            required: ["from", "to"],
          },
          points: {
            type: "array",
            maxItems: 6,
            description:
              "Optional extra points to mark that are not intercepts, turning points or intersections (e.g. a point of tangency the question names). Give only x; y is read off the curve.",
            items: {
              type: "object",
              properties: {
                x: { type: "number" },
                curve: { type: "integer", description: "Index into curves (default 0)." },
                label: { type: "string", description: 'A name for the point, e.g. "P".' },
              },
              required: ["x"],
            },
          },
          label: { type: "string", description: "A short caption for the graph." },
        },
        required: ["curves"],
      },
    },
  },
  plot_triangle: {
    type: "function",
    function: {
      name: "plot_triangle",
      description: "Draw a labelled triangle diagram for a Solution of Triangles problem.",
      parameters: {
        type: "object",
        properties: {
          sideA: { type: ["number", "null"], description: "Length of side a, opposite vertex A. Null if unknown." },
          sideB: { type: ["number", "null"], description: "Length of side b, opposite vertex B. Null if unknown." },
          sideC: { type: ["number", "null"], description: "Length of side c, opposite vertex C. Null if unknown." },
          angleA: { type: ["number", "null"], description: "Angle A in degrees. Null if unknown." },
          angleB: { type: ["number", "null"], description: "Angle B in degrees. Null if unknown." },
          angleC: { type: ["number", "null"], description: "Angle C in degrees. Null if unknown." },
          label: { type: "string", description: "A short caption for the diagram." },
        },
        required: [],
      },
    },
  },
  plot_vector: {
    type: "function",
    function: {
      name: "plot_vector",
      description: "Draw one or more vectors as labelled arrows on a grid, for a Vectors problem.",
      parameters: {
        type: "object",
        properties: {
          vectors: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              properties: {
                label: { type: "string" },
                x: { type: "number" },
                y: { type: "number" },
              },
              required: ["label", "x", "y"],
            },
          },
          label: { type: "string", description: "A short caption for the diagram." },
        },
        required: ["vectors"],
      },
    },
  },
};

/** The platform isn't scoped to one subject/topic, so all diagram types are always offered —
 * VISUAL_DECISION_PROMPT is responsible for both gating (only call a tool if explicitly asked
 * for a visual) and picking the one tool that actually matches what was asked for. */
export const ALL_VISUAL_TOOLS: ChatCompletionTool[] = [
  VISUAL_TOOLS_BY_NAME.plot_function,
  VISUAL_TOOLS_BY_NAME.plot_triangle,
  VISUAL_TOOLS_BY_NAME.plot_vector,
];

// Same three tools, reshaped into Anthropic's tool format (name/description/
// input_schema instead of OpenAI's nested function.{name,description,parameters}).
// Derived from ALL_VISUAL_TOOLS rather than redefined so the two providers'
// schemas can't silently drift apart.
export const ANTHROPIC_VISUAL_TOOLS: Anthropic.Tool[] = ALL_VISUAL_TOOLS.map((t) => ({
  name: t.function.name,
  description: t.function.description,
  input_schema: t.function.parameters as Anthropic.Tool.InputSchema,
}));

export function visualFromToolCall(name: string, args: Record<string, unknown>): Visual | null {
  try {
    if (name === "plot_function") {
      return visualSchema.parse({
        type: "function",
        // A bare `expr` is the tool's previous shape; accepted so a model that
        // still sends it gets a graph rather than nothing.
        curves: args.curves ?? (typeof args.expr === "string" ? [{ expr: args.expr }] : undefined),
        domain: args.domain,
        yRange: args.yRange,
        angleUnit: args.angleUnit,
        shade: args.shade,
        points: args.points,
        label: args.label,
      });
    }
    if (name === "plot_triangle") {
      return visualSchema.parse({
        type: "triangle",
        sides: { a: args.sideA ?? null, b: args.sideB ?? null, c: args.sideC ?? null },
        angles: { A: args.angleA ?? null, B: args.angleB ?? null, C: args.angleC ?? null },
        label: args.label,
      });
    }
    if (name === "plot_vector") {
      return visualSchema.parse({
        type: "vector",
        vectors: args.vectors,
        label: args.label,
      });
    }
  } catch {
    return null;
  }
  return null;
}
