// Best-effort triangle solver — given whichever sides/angles the tutor provided
// (often incomplete, since the student's question may only state some of them),
// try to derive all three side lengths so the diagram can be drawn to actual scale.
// Standard labeling: side a is opposite vertex A, b opposite B, c opposite C.

export interface TriangleInput {
  sides?: { a?: number | null; b?: number | null; c?: number | null };
  angles?: { A?: number | null; B?: number | null; C?: number | null };
}

const toRad = (deg: number) => (deg * Math.PI) / 180;
const toDeg = (rad: number) => (rad * 180) / Math.PI;

/** Returns resolved side lengths {a,b,c}, or null if there isn't enough information
 * (e.g. only one side or one angle given) to determine a unique triangle. */
export function solveTriangleSides(input: TriangleInput): { a: number; b: number; c: number } | null {
  let { a, b, c } = input.sides ?? {};
  let { A, B, C } = input.angles ?? {};
  a = a ?? undefined;
  b = b ?? undefined;
  c = c ?? undefined;
  A = A ?? undefined;
  B = B ?? undefined;
  C = C ?? undefined;

  // Fill in the third angle if two are known — angles always sum to 180.
  if (A !== undefined && B !== undefined && C === undefined) C = 180 - A - B;
  if (A !== undefined && C !== undefined && B === undefined) B = 180 - A - C;
  if (B !== undefined && C !== undefined && A === undefined) A = 180 - B - C;

  // Already have all three sides.
  if (a !== undefined && b !== undefined && c !== undefined) {
    return { a, b, c };
  }

  // SAS — two sides plus their included angle (the angle at the vertex they share).
  if (b !== undefined && c !== undefined && A !== undefined && a === undefined) {
    a = Math.sqrt(b * b + c * c - 2 * b * c * Math.cos(toRad(A)));
    return { a, b, c };
  }
  if (a !== undefined && c !== undefined && B !== undefined && b === undefined) {
    b = Math.sqrt(a * a + c * c - 2 * a * c * Math.cos(toRad(B)));
    return { a, b, c };
  }
  if (a !== undefined && b !== undefined && C !== undefined && c === undefined) {
    c = Math.sqrt(a * a + b * b - 2 * a * b * Math.cos(toRad(C)));
    return { a, b, c };
  }

  // ASA/AAS — all three angles known (directly or derived above) plus any one side:
  // law of sines gives the rest.
  if (A !== undefined && B !== undefined && C !== undefined) {
    const ratio =
      a !== undefined ? a / Math.sin(toRad(A)) : b !== undefined ? b / Math.sin(toRad(B)) : c !== undefined ? c / Math.sin(toRad(C)) : undefined;
    if (ratio !== undefined) {
      return {
        a: a ?? ratio * Math.sin(toRad(A)),
        b: b ?? ratio * Math.sin(toRad(B)),
        c: c ?? ratio * Math.sin(toRad(C)),
      };
    }
  }

  return null;
}

/** Lays out triangle vertices in the plane from side lengths alone (SSS), so any
 * successfully-resolved triangle — regardless of which sides/angles were originally
 * given — can be drawn to true scale. B=(0,0), C=(a,0), A solved via the two
 * remaining distance constraints. Returns null for a geometrically invalid
 * (impossible) combination of side lengths. */
export function layoutTriangle(sides: { a: number; b: number; c: number }): {
  A: { x: number; y: number };
  B: { x: number; y: number };
  C: { x: number; y: number };
} | null {
  const { a, b, c } = sides;
  if (a <= 0 || b <= 0 || c <= 0) return null;
  if (a + b <= c || a + c <= b || b + c <= a) return null; // triangle inequality

  const B = { x: 0, y: 0 };
  const C = { x: a, y: 0 };
  const x = (c * c - b * b + a * a) / (2 * a);
  const ySq = c * c - x * x;
  if (ySq < 0) return null;
  const A = { x, y: Math.sqrt(ySq) };
  return { A, B, C };
}

export function angleBetween(p1: { x: number; y: number }, vertex: { x: number; y: number }, p2: { x: number; y: number }): number {
  const v1 = { x: p1.x - vertex.x, y: p1.y - vertex.y };
  const v2 = { x: p2.x - vertex.x, y: p2.y - vertex.y };
  const dot = v1.x * v2.x + v1.y * v2.y;
  const mag = Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y);
  return toDeg(Math.acos(Math.max(-1, Math.min(1, dot / mag))));
}
