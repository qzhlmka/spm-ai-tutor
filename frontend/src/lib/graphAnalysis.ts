// Key points of a plotted graph, computed numerically from the expressions
// themselves — never taken from the model. The model chooses WHAT to plot; the
// coordinates students read off the graph (intercepts, turning points,
// intersections) come from here, so a graph can't show the right curve with a
// wrong label, the failure measured on generated images (a parabola drawn
// through y = 3.9 under a "(0, 3)" label).

export type Fn = (x: number) => number;

export type KeyPointKind = "x-intercept" | "y-intercept" | "minimum" | "maximum" | "intersection" | "marked";

export interface KeyPoint {
  x: number;
  y: number;
  kind: KeyPointKind;
  /** Index of the curve the point lies on (the first one, for an intersection). */
  curve: number;
  label?: string;
}

const SAMPLES = 1200;

function safe(f: Fn, x: number): number {
  try {
    const y = f(x);
    return Number.isFinite(y) ? y : NaN;
  } catch {
    return NaN;
  }
}

/** Rounds away floating-point noise so 0.9999999999 reads as 1 and -0 as 0. */
export function snap(v: number): number {
  const r = Math.round(v);
  if (Math.abs(v - r) < 1e-7) return r === 0 ? 0 : r;
  const s = Math.round(v * 1e6) / 1e6;
  return s === 0 ? 0 : s;
}

function bisect(g: Fn, a: number, b: number): number {
  let ga = g(a);
  for (let i = 0; i < 80; i++) {
    const m = (a + b) / 2;
    const gm = g(m);
    if (gm === 0) return m;
    if (Math.sign(gm) === Math.sign(ga)) {
      a = m;
      ga = gm;
    } else {
      b = m;
    }
  }
  return (a + b) / 2;
}

/** Zeros of g on [lo, hi]: sign changes refined by bisection, plus touching zeros
 * (a double root like (x - 2)², which never changes sign). A sign change across
 * an asymptote (1/x at 0, tan at π/2) is rejected because |g| there is huge,
 * not near zero. */
function zeros(g: Fn, lo: number, hi: number, scale: number): number[] {
  const out: number[] = [];
  const step = (hi - lo) / SAMPLES;
  const tol = 1e-6 * (1 + scale);
  // Floating-point noise is zero too: sin(2π) is -2.4e-16, not 0, and with no
  // sign change after it the root at the domain's end would otherwise be lost.
  const zeroTol = 1e-12 * (1 + scale);
  let px = lo;
  let py = safe(g, lo);
  if (Math.abs(py) <= zeroTol) out.push(lo);
  for (let i = 1; i <= SAMPLES; i++) {
    const x = lo + step * i;
    const y = safe(g, x);
    if (Math.abs(y) <= zeroTol) out.push(x);
    else if (Number.isFinite(py) && Number.isFinite(y) && Math.abs(py) > zeroTol && Math.sign(py) !== Math.sign(y)) {
      const r = bisect((t) => safe(g, t), px, x);
      if (Math.abs(safe(g, r)) < tol) out.push(r);
    }
    px = x;
    py = y;
  }
  return out;
}

/** Golden-section search for the extremum of f inside [a, b]. */
function extremum(f: Fn, a: number, b: number, findMax: boolean): number {
  const phi = (Math.sqrt(5) - 1) / 2;
  const h = findMax ? (x: number) => -safe(f, x) : (x: number) => safe(f, x);
  let c = b - phi * (b - a);
  let d = a + phi * (b - a);
  for (let i = 0; i < 100; i++) {
    if (h(c) < h(d)) b = d;
    else a = c;
    c = b - phi * (b - a);
    d = a + phi * (b - a);
  }
  return (a + b) / 2;
}

function turningPoints(f: Fn, lo: number, hi: number, curve: number): KeyPoint[] {
  const out: KeyPoint[] = [];
  const step = (hi - lo) / SAMPLES;
  const ys = Array.from({ length: SAMPLES + 1 }, (_, i) => safe(f, lo + step * i));
  const mags = ys.filter(Number.isFinite).map(Math.abs).sort((a, b) => a - b);
  const typical = mags.length ? mags[Math.floor(mags.length / 2)] : 1;
  for (let i = 1; i < SAMPLES; i++) {
    const [a, b, c] = [ys[i - 1], ys[i], ys[i + 1]];
    if (![a, b, c].every(Number.isFinite)) continue;
    const isMax = b > a && b >= c;
    const isMin = b < a && b <= c;
    if (!isMax && !isMin) continue;
    const x = extremum(f, lo + step * (i - 1), lo + step * (i + 1), isMax);
    const y = safe(f, x);
    // A cusp of |x| is a real turning point; the spike at an asymptote (tan at
    // π/2) is not — it sits orders of magnitude above the curve's typical size.
    if (!Number.isFinite(y) || Math.abs(y) > 1e3 * (1 + typical)) continue;
    out.push({ x, y, kind: isMax ? "maximum" : "minimum", curve });
  }
  return out;
}

function dedupe(points: KeyPoint[], tol: number): KeyPoint[] {
  const out: KeyPoint[] = [];
  for (const p of points) {
    if (!out.some((q) => Math.abs(q.x - p.x) < tol && Math.abs(q.y - p.y) < tol)) out.push(p);
  }
  return out;
}

export interface MarkedPoint {
  x: number;
  curve?: number;
  label?: string;
}

/** Every key point on the given curves over [lo, hi], snapped to clean values. */
export function analyseGraph(fns: Fn[], lo: number, hi: number, marked: MarkedPoint[] = []): KeyPoint[] {
  const points: KeyPoint[] = [];
  // A curve's typical size (median |y|), not its largest: tan's largest sample
  // is ~1e16, and tolerances scaled from that call every sample a root.
  const scales = fns.map((f) => {
    const ys = Array.from({ length: 101 }, (_, i) => Math.abs(safe(f, lo + ((hi - lo) * i) / 100))).filter(Number.isFinite).sort((a, b) => a - b);
    return ys.length ? ys[Math.floor(ys.length / 2)] : 1;
  });

  fns.forEach((f, i) => {
    const turning = turningPoints(f, lo, hi, i);
    points.push(...turning);
    for (const x of zeros(f, lo, hi, scales[i])) points.push({ x, y: 0, kind: "x-intercept", curve: i });
    // Double roots: a turning point sitting on the x-axis is also an intercept.
    for (const t of turning) if (Math.abs(t.y) < 1e-7 * (1 + scales[i])) points.push({ x: t.x, y: 0, kind: "x-intercept", curve: i });
    if (lo <= 0 && hi >= 0) {
      const y = safe(f, 0);
      if (Number.isFinite(y)) points.push({ x: 0, y, kind: "y-intercept", curve: i });
    }
  });

  for (let i = 0; i < fns.length; i++) {
    for (let j = i + 1; j < fns.length; j++) {
      const g = (x: number) => fns[i](x) - fns[j](x);
      for (const x of zeros(g, lo, hi, Math.max(scales[i], scales[j]))) {
        points.push({ x, y: safe(fns[i], x), kind: "intersection", curve: i });
      }
    }
  }

  // Points the model asked to mark: it gives only x; y is computed from the curve,
  // so a marked point is always on the line it labels.
  for (const m of marked) {
    const curve = m.curve !== undefined && m.curve >= 0 && m.curve < fns.length ? m.curve : 0;
    const y = safe(fns[curve], m.x);
    if (Number.isFinite(y) && m.x >= lo && m.x <= hi) points.push({ x: m.x, y, kind: "marked", curve, label: m.label });
  }

  const snapped = points.map((p) => ({ ...p, x: snap(p.x), y: snap(p.y) }));
  // Keep the most specific kind when two coincide: a minimum on the axis stays
  // labelled as the minimum, a marked point keeps the model's label.
  const rank: Record<KeyPointKind, number> = { marked: 0, minimum: 1, maximum: 1, intersection: 2, "y-intercept": 3, "x-intercept": 4 };
  snapped.sort((a, b) => rank[a.kind] - rank[b.kind]);
  return dedupe(snapped, 1e-6 * (1 + hi - lo));
}

const PI_FRACTIONS: [number, string][] = [
  [1, "π"], [1 / 2, "π/2"], [1 / 3, "π/3"], [1 / 4, "π/4"], [1 / 6, "π/6"],
  [2 / 3, "2π/3"], [3 / 4, "3π/4"], [5 / 6, "5π/6"], [3 / 2, "3π/2"], [4 / 3, "4π/3"],
  [5 / 4, "5π/4"], [7 / 6, "7π/6"], [5 / 3, "5π/3"], [7 / 4, "7π/4"], [11 / 6, "11π/6"], [2, "2π"],
];

/** A number as a student writes it: integers bare, otherwise up to 2 dp, true minus sign.
 * With `piUnits`, a clean multiple of π is shown as one ("3π/2"). */
export function formatNumber(v: number, piUnits = false): string {
  if (piUnits && v !== 0) {
    const k = Math.abs(v) / Math.PI;
    const hit = PI_FRACTIONS.find(([f]) => Math.abs(k - f) < 1e-6);
    if (hit) return (v < 0 ? "−" : "") + hit[1];
    const n = Math.round(k);
    if (n > 2 && Math.abs(k - n) < 1e-6) return `${v < 0 ? "−" : ""}${n}π`;
  }
  const s = Number.isInteger(v) ? String(v) : String(Number(v.toFixed(2)));
  return s === "-0" ? "0" : s.replace("-", "−");
}

/** Tick values on [lo, hi]: 1-2-5 steps, or multiples of π/2-ish for trig in radians. */
export function ticks(lo: number, hi: number, piUnits = false, target = 8): number[] {
  const span = hi - lo;
  let step: number;
  if (piUnits) {
    const options = [Math.PI / 6, Math.PI / 4, Math.PI / 2, Math.PI, 2 * Math.PI, 4 * Math.PI];
    step = options.find((s) => span / s <= target) ?? options[options.length - 1];
  } else {
    const raw = span / target;
    const mag = 10 ** Math.floor(Math.log10(raw));
    step = ([1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag);
  }
  const out: number[] = [];
  for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + 1e-9; v += step) out.push(snap(v));
  return out;
}

/** A y-window that shows the curve's shape: the full range normally, but trimmed
 * to the bulk of the samples when an asymptote would otherwise flatten everything. */
export function yWindow(fns: Fn[], lo: number, hi: number, keyPoints: KeyPoint[]): [number, number] {
  const ys: number[] = [];
  for (const f of fns) for (let i = 0; i <= 400; i++) {
    const y = safe(f, lo + ((hi - lo) * i) / 400);
    if (Number.isFinite(y)) ys.push(y);
  }
  if (ys.length === 0) return [-10, 10];
  ys.sort((a, b) => a - b);
  let yMin = ys[0];
  let yMax = ys[ys.length - 1];
  const p = (q: number) => ys[Math.min(ys.length - 1, Math.max(0, Math.round(q * (ys.length - 1))))];
  const core = p(0.95) - p(0.05);
  if (core > 0 && yMax - yMin > 8 * core) {
    yMin = p(0.05) - core;
    yMax = p(0.95) + core;
  }
  for (const k of keyPoints) {
    if (k.kind !== "x-intercept" && Math.abs(k.y - (yMin + yMax) / 2) < 4 * (yMax - yMin + 1)) {
      yMin = Math.min(yMin, k.y);
      yMax = Math.max(yMax, k.y);
    }
  }
  // Pull in the x-axis when it's nearby, so intercepts and signs are visible.
  const span = yMax - yMin || 2;
  if (yMin > 0 && yMin < span) yMin = 0;
  if (yMax < 0 && -yMax < span) yMax = 0;
  if (yMin === yMax) {
    yMin -= 1;
    yMax += 1;
  }
  const pad = (yMax - yMin) * 0.12;
  return [yMin - pad, yMax + pad];
}

const SUPERSCRIPT: Record<string, string> = { "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹", "-": "⁻", x: "ˣ" };

/** "x^2 - 4*x + 3" → "x² − 4x + 3", for captions and the legend. */
export function prettyExpr(expr: string): string {
  return expr
    .replace(/\^\(?(-?[0-9x]+)\)?/g, (_, p: string) => [...p].map((c) => SUPERSCRIPT[c] ?? c).join(""))
    .replace(/(\d)\s*\*\s*(?=[a-z(])/gi, "$1")
    .replace(/\*/g, "·")
    .replace(/sqrt/g, "√")
    .replace(/pi/g, "π")
    // Only a minus between terms, never the hyphen in a caption's "x-axis".
    .replace(/ - /g, " − ")
    .replace(/(^|[\s(=])-(?=[\dx(a-z])/gi, "$1−")
    .replace(/([\dx)])-(?=[\dx(])/g, "$1−");
}
