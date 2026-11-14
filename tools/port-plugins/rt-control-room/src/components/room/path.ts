// Point-on-path maths for the moving dots. jsdom (and any host without SVG
// geometry) has no getTotalLength, so positions are computed from the same
// numbers that draw the paths.

export type Pt = { x: number; y: number };
export type Curve =
  | { kind: "cubic"; p: [Pt, Pt, Pt, Pt] }
  | { kind: "poly"; pts: Pt[] };

const f = (n: number): string => String(Math.round(n * 100) / 100);

export function toD(curve: Curve): string {
  if (curve.kind === "cubic") {
    const [a, b, c, d] = curve.p;
    return `M${f(a.x)} ${f(a.y)} C ${f(b.x)} ${f(b.y)}, ${f(c.x)} ${f(c.y)}, ${f(d.x)} ${f(d.y)}`;
  }
  return curve.pts.map((p, i) => `${i === 0 ? "M" : "L"}${f(p.x)} ${f(p.y)}`).join(" ");
}

function cubicAt(p: [Pt, Pt, Pt, Pt], t: number): Pt {
  const u = 1 - t;
  const w = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
  return {
    x: w[0] * p[0].x + w[1] * p[1].x + w[2] * p[2].x + w[3] * p[3].x,
    y: w[0] * p[0].y + w[1] * p[1].y + w[2] * p[2].y + w[3] * p[3].y,
  };
}

function polyAt(pts: Pt[], k: number): Pt {
  const last = pts[pts.length - 1] ?? { x: 0, y: 0 };
  if (pts.length < 2) return last;
  const lengths: number[] = [];
  let total = 0;
  for (let i = 1; i < pts.length; i += 1) {
    const len = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    lengths.push(len);
    total += len;
  }
  let left = Math.min(1, Math.max(0, k)) * total;
  for (let i = 0; i < lengths.length; i += 1) {
    if (left <= lengths[i] || i === lengths.length - 1) {
      const r = lengths[i] === 0 ? 1 : Math.min(1, left / lengths[i]);
      return { x: pts[i].x + (pts[i + 1].x - pts[i].x) * r, y: pts[i].y + (pts[i + 1].y - pts[i].y) * r };
    }
    left -= lengths[i];
  }
  return last;
}

/** The point a fraction `k` (0..1) of the way along the curve. */
export function pointAt(curve: Curve, k: number): Pt {
  const t = Math.min(1, Math.max(0, k));
  return curve.kind === "cubic" ? cubicAt(curve.p, t) : polyAt(curve.pts, t);
}

export function reversed(curve: Curve): Curve {
  return curve.kind === "cubic"
    ? { kind: "cubic", p: [curve.p[3], curve.p[2], curve.p[1], curve.p[0]] }
    : { kind: "poly", pts: [...curve.pts].reverse() };
}
