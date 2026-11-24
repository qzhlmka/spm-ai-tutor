import { useId, useMemo } from "react";
import type { FunctionVisual } from "../types";
import { compileExpr } from "../lib/mathEval";
import { analyseGraph, formatNumber, prettyExpr, ticks, yWindow, type Fn, type KeyPoint } from "../lib/graphAnalysis";

const W = 420;
const H = 320;
const M = { l: 40, r: 18, t: 18, b: 30 };
const SAMPLES = 600;
const FONT = 10;
const CHAR_W = 5.7; // approximate advance at FONT px, for label collision checks

// One stroke class per curve; the dot/legend swatch reuse the same hue.
const CURVE_CLASSES = [
  { stroke: "stroke-blue-600 dark:stroke-blue-400", fill: "fill-blue-600 dark:fill-blue-400", swatch: "bg-blue-600 dark:bg-blue-400" },
  { stroke: "stroke-rose-600 dark:stroke-rose-400", fill: "fill-rose-600 dark:fill-rose-400", swatch: "bg-rose-600 dark:bg-rose-400" },
  { stroke: "stroke-emerald-600 dark:stroke-emerald-400", fill: "fill-emerald-600 dark:fill-emerald-400", swatch: "bg-emerald-600 dark:bg-emerald-400" },
  { stroke: "stroke-amber-600 dark:stroke-amber-400", fill: "fill-amber-600 dark:fill-amber-400", swatch: "bg-amber-600 dark:bg-amber-400" },
];

// No \b: "2sin(x)" has no word boundary before "sin".
const TRIG = /(sin|cos|tan)\s*\(/i;

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
const overlaps = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

function safe(f: Fn, x: number): number {
  try {
    const y = f(x);
    return Number.isFinite(y) ? y : NaN;
  } catch {
    return NaN;
  }
}

export function FunctionGraph({ visual }: { visual: FunctionVisual }) {
  const clipId = `graph-clip-${useId().replace(/[^a-zA-Z0-9-]/g, "")}`;
  const unit = visual.angleUnit ?? "radians";
  const isTrig = visual.curves.some((c) => TRIG.test(c.expr));
  const piUnits = isTrig && unit === "radians";

  const model = useMemo(() => {
    let fns: Fn[];
    try {
      fns = visual.curves.map((c) => compileExpr(c.expr, unit));
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
    const [lo, hi] =
      visual.domain ?? (isTrig ? (unit === "degrees" ? [0, 360] : [0, 2 * Math.PI]) : [-10, 10]);
    const keyPoints = analyseGraph(fns, lo, hi, visual.points ?? []);
    const [yLo, yHi] = visual.yRange ?? yWindow(fns, lo, hi, keyPoints);
    return { fns, lo, hi, yLo, yHi, keyPoints };
  }, [visual, unit, isTrig]);

  if ("error" in model) {
    return (
      <p className="text-xs text-neutral-400 dark:text-neutral-500">
        Couldn't draw this graph ({model.error}).
      </p>
    );
  }
  const { fns, lo, hi, yLo, yHi, keyPoints } = model;

  const pw = W - M.l - M.r;
  const ph = H - M.t - M.b;
  const sx = (x: number) => M.l + ((x - lo) / (hi - lo)) * pw;
  const sy = (y: number) => M.t + ph - ((y - yLo) / (yHi - yLo)) * ph;

  // Curves as paths, broken wherever the function is undefined or jumps
  // further than the whole window in one step (an asymptote, not a steep curve).
  const paths = fns.map((f) => {
    let d = "";
    let prev = NaN;
    for (let i = 0; i <= SAMPLES; i++) {
      const x = lo + ((hi - lo) * i) / SAMPLES;
      const y = safe(f, x);
      const jump = Number.isFinite(prev) && Number.isFinite(y) && Math.abs(y - prev) > yHi - yLo;
      if (!Number.isFinite(y) || jump) {
        prev = jump ? y : NaN;
        if (jump) d += `M${sx(x).toFixed(1)},${sy(y).toFixed(1)} `;
        continue;
      }
      d += `${Number.isFinite(prev) ? "L" : "M"}${sx(x).toFixed(1)},${sy(y).toFixed(1)} `;
      prev = y;
    }
    return d;
  });

  // Shaded region (Integration): between a curve and the x-axis, or two curves.
  let shadePath = "";
  if (visual.shade) {
    const a = Math.max(lo, Math.min(visual.shade.from, visual.shade.to));
    const b = Math.min(hi, Math.max(visual.shade.from, visual.shade.to));
    const top = fns[visual.shade.curve ?? 0] ?? fns[0];
    const bottomFn = visual.shade.between !== undefined ? fns[visual.shade.between] : undefined;
    const clampY = (y: number) => Math.max(yLo, Math.min(yHi, y));
    if (b > a) {
      const n = 200;
      const xs = Array.from({ length: n + 1 }, (_, i) => a + ((b - a) * i) / n);
      const upper = xs.map((x) => `${sx(x).toFixed(1)},${sy(clampY(safe(top, x) || 0)).toFixed(1)}`);
      const lower = xs
        .slice()
        .reverse()
        .map((x) => `${sx(x).toFixed(1)},${sy(clampY(bottomFn ? safe(bottomFn, x) || 0 : 0)).toFixed(1)}`);
      shadePath = `M${upper.join(" L")} L${lower.join(" L")} Z`;
    }
  }

  // Axes sit at x = 0 / y = 0 when visible, else along the window's edge.
  const xAxisY = yLo <= 0 && yHi >= 0 ? sy(0) : sy(yLo);
  const yAxisX = lo <= 0 && hi >= 0 ? sx(0) : sx(lo);
  const originVisible = yLo <= 0 && yHi >= 0 && lo <= 0 && hi >= 0;
  const xTicks = ticks(lo, hi, piUnits, 9);
  const yTicks = ticks(yLo, yHi, false, 7);

  // Key-point labels, placed without overlapping each other or leaving the plot.
  const visible = keyPoints.filter((p) => p.x >= lo && p.x <= hi && p.y >= yLo && p.y <= yHi);
  const labelled =
    visible.length > 10 ? visible.filter((p) => p.kind !== "x-intercept" && p.kind !== "y-intercept") : visible;
  // Tick labels are placed first, so a point label never covers an axis number.
  const placed: Box[] = [
    ...xTicks.map((t) => {
      const w = formatNumber(t, piUnits).length * CHAR_W;
      return { x: sx(t) - w / 2, y: Math.min(xAxisY + 14, H - 4) - FONT, w, h: FONT + 2 };
    }),
    ...yTicks.map((t) => {
      const w = formatNumber(t).length * CHAR_W;
      return { x: Math.max(yAxisX - 6, 22) - w, y: sy(t) + 3.5 - FONT, w, h: FONT + 2 };
    }),
  ];
  const labels: { p: KeyPoint; text: string; x: number; y: number; anchor: "start" | "end" }[] = [];
  for (const p of labelled) {
    const coords = `(${formatNumber(p.x, piUnits)}, ${formatNumber(p.y)})`;
    const text = p.label ? `${p.label} ${coords}` : coords;
    const w = text.length * CHAR_W;
    const h = FONT + 2;
    const px = sx(p.x);
    const py = sy(p.y);
    const below = p.kind === "minimum" || p.kind === "x-intercept";
    const order: [number, number][] = below
      ? [[6, 14], [-6, 14], [6, -6], [-6, -6], [6, 26], [-6, 26]]
      : [[6, -6], [-6, -6], [6, 14], [-6, 14], [6, -18], [-6, -18]];
    for (const [dx, dy] of order) {
      const anchor = dx >= 0 ? "start" : "end";
      const box: Box = { x: anchor === "start" ? px + dx : px + dx - w, y: py + dy - FONT, w, h };
      const inside = box.x >= M.l && box.x + box.w <= W - M.r && box.y >= M.t && box.y + box.h <= H - M.b;
      if (inside && !placed.some((b) => overlaps(b, box))) {
        placed.push(box);
        labels.push({ p, text, x: px + dx, y: py + dy, anchor });
        break;
      }
    }
  }

  return (
    <div className="w-full max-w-md">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={visual.label ?? visual.curves.map((c) => prettyExpr(c.label ?? `y = ${c.expr}`)).join(", ")}>
        <defs>
          <clipPath id={clipId}>
            <rect x={M.l} y={M.t} width={pw} height={ph} />
          </clipPath>
        </defs>
        <rect x={0} y={0} width={W} height={H} className="fill-white dark:fill-neutral-900" />

        {/* grid */}
        {xTicks.map((t) => (
          <line key={`gx${t}`} x1={sx(t)} y1={M.t} x2={sx(t)} y2={H - M.b} className="stroke-neutral-100 dark:stroke-neutral-800" />
        ))}
        {yTicks.map((t) => (
          <line key={`gy${t}`} x1={M.l} y1={sy(t)} x2={W - M.r} y2={sy(t)} className="stroke-neutral-100 dark:stroke-neutral-800" />
        ))}

        {shadePath && <path d={shadePath} clipPath={`url(#${clipId})`} className="fill-blue-500/20 dark:fill-blue-400/20" />}

        {/* axes */}
        <line x1={M.l} y1={xAxisY} x2={W - M.r + 6} y2={xAxisY} className="stroke-neutral-500 dark:stroke-neutral-400" strokeWidth={1.2} />
        <line x1={yAxisX} y1={H - M.b} x2={yAxisX} y2={M.t - 6} className="stroke-neutral-500 dark:stroke-neutral-400" strokeWidth={1.2} />
        <path d={`M${W - M.r + 6},${xAxisY} l-6,-3.5 v7 z`} className="fill-neutral-500 dark:fill-neutral-400" />
        <path d={`M${yAxisX},${M.t - 6} l-3.5,6 h7 z`} className="fill-neutral-500 dark:fill-neutral-400" />
        <text x={W - M.r + 4} y={xAxisY - 6} className="fill-neutral-600 italic dark:fill-neutral-300" fontSize={12}>x</text>
        <text x={yAxisX + 6} y={M.t - 2} className="fill-neutral-600 italic dark:fill-neutral-300" fontSize={12}>y</text>

        {/* tick labels */}
        {xTicks.map((t) =>
          t === 0 && originVisible ? null : (
            <g key={`tx${t}`}>
              <line x1={sx(t)} y1={xAxisY - 3} x2={sx(t)} y2={xAxisY + 3} className="stroke-neutral-500 dark:stroke-neutral-400" />
              <text x={sx(t)} y={Math.min(xAxisY + 14, H - 4)} textAnchor="middle" fontSize={FONT} className="fill-neutral-500 dark:fill-neutral-400">
                {formatNumber(t, piUnits)}
              </text>
            </g>
          ),
        )}
        {yTicks.map((t) =>
          t === 0 && originVisible ? null : (
            <g key={`ty${t}`}>
              <line x1={yAxisX - 3} y1={sy(t)} x2={yAxisX + 3} y2={sy(t)} className="stroke-neutral-500 dark:stroke-neutral-400" />
              <text x={Math.max(yAxisX - 6, 22)} y={sy(t) + 3.5} textAnchor="end" fontSize={FONT} className="fill-neutral-500 dark:fill-neutral-400">
                {formatNumber(t)}
              </text>
            </g>
          ),
        )}
        {originVisible && (
          <text x={yAxisX - 5} y={xAxisY + 13} textAnchor="end" fontSize={FONT} className="fill-neutral-500 italic dark:fill-neutral-400">O</text>
        )}

        {/* curves */}
        <g clipPath={`url(#${clipId})`}>
          {paths.map((d, i) => (
            <path key={i} d={d} fill="none" strokeWidth={2} strokeLinejoin="round" className={CURVE_CLASSES[i % 4].stroke} />
          ))}
        </g>

        {/* key points */}
        {visible.map((p, i) => (
          <circle key={i} cx={sx(p.x)} cy={sy(p.y)} r={3.2} className={`${CURVE_CLASSES[p.curve % 4].fill} stroke-white dark:stroke-neutral-900`} strokeWidth={1} />
        ))}
        {labels.map((l, i) => (
          <text key={i} x={l.x} y={l.y} textAnchor={l.anchor} fontSize={FONT} className="fill-neutral-800 font-medium dark:fill-neutral-100">
            {l.text}
          </text>
        ))}
      </svg>

      {visual.curves.length > 1 && (
        <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-neutral-600 dark:text-neutral-300">
          {visual.curves.map((c, i) => (
            <li key={i} className="flex items-center gap-1.5">
              <span className={`inline-block h-0.5 w-4 rounded ${CURVE_CLASSES[i % 4].swatch}`} />
              {prettyExpr(c.label ?? `y = ${c.expr}`)}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
        {prettyExpr(visual.label ?? (visual.curves.length === 1 ? visual.curves[0].label ?? `y = ${visual.curves[0].expr}` : ""))}
      </p>
    </div>
  );
}
