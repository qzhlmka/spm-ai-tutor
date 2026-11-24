import { useMemo } from "react";
import type { Visual } from "../types";
import { FunctionGraph } from "./FunctionGraph";
import { angleBetween, layoutTriangle, solveTriangleSides } from "../lib/triangleSolver";

interface VisualRendererProps {
  visual: Visual;
}

const SIZE = 300;
const PADDING = 28;

function ErrorNote({ message }: { message: string }) {
  return <p className="text-xs text-neutral-400 dark:text-neutral-500">{message}</p>;
}

function TrianglePlot({ visual }: { visual: Extract<Visual, { type: "triangle" }> }) {
  const solved = useMemo(() => solveTriangleSides(visual), [visual]);
  const layout = useMemo(() => (solved ? layoutTriangle(solved) : null), [solved]);

  if (!solved || !layout) {
    return <ErrorNote message="Not enough information given to draw this triangle to scale." />;
  }

  const { A, B, C } = layout;
  const xs = [A.x, B.x, C.x];
  const ys = [A.y, B.y, C.y];
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  const plotSize = SIZE - PADDING * 2;
  const scale = Math.min(plotSize / spanX, plotSize / spanY) * 0.85;
  const offsetX = PADDING + (plotSize - spanX * scale) / 2;
  const offsetY = PADDING + (plotSize - spanY * scale) / 2;
  // SVG y grows downward — flip so the triangle isn't upside down.
  const project = (p: { x: number; y: number }) => ({
    x: offsetX + (p.x - minX) * scale,
    y: SIZE - PADDING - (p.y - minY) * scale - (PADDING - offsetY),
  });

  const pA = project(A);
  const pB = project(B);
  const pC = project(C);

  const angleA = visual.angles?.A ?? angleBetween(B, A, C);
  const angleB = visual.angles?.B ?? angleBetween(A, B, C);
  const angleC = visual.angles?.C ?? angleBetween(A, C, B);

  const labelOffset = (p: { x: number; y: number }, center: { x: number; y: number }, dist: number) => {
    const dx = p.x - center.x;
    const dy = p.y - center.y;
    const len = Math.hypot(dx, dy) || 1;
    return { x: p.x + (dx / len) * dist, y: p.y + (dy / len) * dist };
  };
  const centroid = { x: (pA.x + pB.x + pC.x) / 3, y: (pA.y + pB.y + pC.y) / 3 };
  const labelA = labelOffset(pA, centroid, -16);
  const labelB = labelOffset(pB, centroid, -16);
  const labelC = labelOffset(pC, centroid, -16);
  const midAB = { x: (pA.x + pB.x) / 2, y: (pA.y + pB.y) / 2 };
  const midBC = { x: (pB.x + pC.x) / 2, y: (pB.y + pC.y) / 2 };
  const midCA = { x: (pC.x + pA.x) / 2, y: (pC.y + pA.y) / 2 };

  return (
    <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="h-auto w-full max-w-xs">
      <rect x={0} y={0} width={SIZE} height={SIZE} className="fill-white dark:fill-neutral-900" />
      <polygon
        points={`${pA.x},${pA.y} ${pB.x},${pB.y} ${pC.x},${pC.y}`}
        className="fill-blue-50 stroke-blue-500 dark:fill-blue-500/10 dark:stroke-blue-400"
        strokeWidth={2}
      />
      <text x={labelA.x} y={labelA.y} textAnchor="middle" className="fill-neutral-700 text-xs font-medium dark:fill-neutral-200">
        A ({angleA.toFixed(0)}°)
      </text>
      <text x={labelB.x} y={labelB.y} textAnchor="middle" className="fill-neutral-700 text-xs font-medium dark:fill-neutral-200">
        B ({angleB.toFixed(0)}°)
      </text>
      <text x={labelC.x} y={labelC.y} textAnchor="middle" className="fill-neutral-700 text-xs font-medium dark:fill-neutral-200">
        C ({angleC.toFixed(0)}°)
      </text>
      <text x={midAB.x} y={midAB.y - 6} textAnchor="middle" className="fill-neutral-500 text-[10px] dark:fill-neutral-400">
        c = {solved.c.toFixed(1)}
      </text>
      <text x={midBC.x} y={midBC.y + 14} textAnchor="middle" className="fill-neutral-500 text-[10px] dark:fill-neutral-400">
        a = {solved.a.toFixed(1)}
      </text>
      <text x={midCA.x} y={midCA.y} textAnchor="middle" className="fill-neutral-500 text-[10px] dark:fill-neutral-400">
        b = {solved.b.toFixed(1)}
      </text>
    </svg>
  );
}

function VectorPlot({ visual }: { visual: Extract<Visual, { type: "vector" }> }) {
  const xs = [0, ...visual.vectors.map((v) => v.x)];
  const ys = [0, ...visual.vectors.map((v) => v.y)];
  const maxAbs = Math.max(1, ...xs.map(Math.abs), ...ys.map(Math.abs)) * 1.2;
  const plotSize = SIZE - PADDING * 2;
  const scale = plotSize / (maxAbs * 2);
  const originX = SIZE / 2;
  const originY = SIZE / 2;
  const sx = (x: number) => originX + x * scale;
  const sy = (y: number) => originY - y * scale;

  return (
    <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="h-auto w-full max-w-xs">
      <defs>
        <marker id="arrowhead" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
          <path d="M0,0 L8,4 L0,8 Z" className="fill-blue-500 dark:fill-blue-400" />
        </marker>
      </defs>
      <rect x={0} y={0} width={SIZE} height={SIZE} className="fill-white dark:fill-neutral-900" />
      <line x1={PADDING} y1={originY} x2={SIZE - PADDING} y2={originY} className="stroke-neutral-300 dark:stroke-neutral-600" />
      <line x1={originX} y1={PADDING} x2={originX} y2={SIZE - PADDING} className="stroke-neutral-300 dark:stroke-neutral-600" />
      {visual.vectors.map((v, i) => (
        <g key={i}>
          <line
            x1={sx(0)}
            y1={sy(0)}
            x2={sx(v.x)}
            y2={sy(v.y)}
            markerEnd="url(#arrowhead)"
            className="stroke-blue-500 dark:stroke-blue-400"
            strokeWidth={2}
          />
          <text
            x={sx(v.x) + (v.x >= 0 ? 6 : -6)}
            y={sy(v.y) - 6}
            textAnchor={v.x >= 0 ? "start" : "end"}
            className="fill-neutral-700 text-xs font-medium dark:fill-neutral-200"
          >
            {v.label}
          </text>
        </g>
      ))}
    </svg>
  );
}

export function VisualRenderer({ visual }: VisualRendererProps) {
  return (
    <div className="mt-2 flex flex-col items-start gap-1 rounded-lg border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-900">
      {visual.type === "function" && <FunctionGraph visual={visual} />}
      {visual.type === "triangle" && <TrianglePlot visual={visual} />}
      {visual.type === "vector" && <VectorPlot visual={visual} />}
      {visual.label && visual.type !== "function" && (
        <p className="text-xs text-neutral-500 dark:text-neutral-400">{visual.label}</p>
      )}
    </div>
  );
}
