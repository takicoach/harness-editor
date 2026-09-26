export interface Pt { x: number; y: number }

/** Normalized 0..1 shape points scaled by the frame's real size (anisotropic on purpose). */
export function shapePixelPoints(
  s: { x1: number; y1: number; x2: number; y2: number; x3?: number; y3?: number },
  w: number, h: number,
): { p1: Pt; p2: Pt; p3: Pt } {
  return { p1: { x: s.x1 * w, y: s.y1 * h }, p2: { x: s.x2 * w, y: s.y2 * h },
    p3: { x: (s.x3 ?? s.x2) * w, y: (s.y3 ?? s.y2) * h } };
}

/** 0..180 between vertex→a and vertex→b, in the caller's units. 0 when either side has no length. */
export function angleDegrees(vertex: Pt, a: Pt, b: Pt): number {
  const ax = a.x - vertex.x, ay = a.y - vertex.y, bx = b.x - vertex.x, by = b.y - vertex.y;
  const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
  if (la === 0 || lb === 0) return 0;
  const cos = Math.min(1, Math.max(-1, (ax * bx + ay * by) / (la * lb)));
  return Math.acos(cos) * 180 / Math.PI;
}

/** Upward isosceles triangle inscribed in the box spanned by the two points. */
export function trianglePoints(x1: number, y1: number, x2: number, y2: number): [Pt, Pt, Pt] {
  const left = Math.min(x1, x2), right = Math.max(x1, x2), top = Math.min(y1, y2), bottom = Math.max(y1, y2);
  return [{ x: (left + right) / 2, y: top }, { x: right, y: bottom }, { x: left, y: bottom }];
}

/** SVG arc from the a-side to the b-side, radius r, drawn the short way round. */
export function angleArcPath(vertex: Pt, a: Pt, b: Pt, radius: number): string {
  const round = (value: number): number => Math.round(value * 1e6) / 1e6;
  const at = (p: Pt): Pt => {
    const dx = p.x - vertex.x, dy = p.y - vertex.y, length = Math.hypot(dx, dy) || 1;
    return { x: round(vertex.x + dx / length * radius), y: round(vertex.y + dy / length * radius) };
  };
  const start = at(a), end = at(b);
  const sweep = (a.x - vertex.x) * (b.y - vertex.y) - (a.y - vertex.y) * (b.x - vertex.x) >= 0 ? 1 : 0;
  return `M ${start.x} ${start.y} A ${radius} ${radius} 0 0 ${sweep} ${end.x} ${end.y}`;
}

/** Where to place the degree readout: on the bisector, just outside the arc. */
export function angleLabelPoint(vertex: Pt, a: Pt, b: Pt, radius: number): Pt {
  const unit = (p: Pt): Pt => {
    const dx = p.x - vertex.x, dy = p.y - vertex.y, length = Math.hypot(dx, dy) || 1;
    return { x: dx / length, y: dy / length };
  };
  const ua = unit(a), ub = unit(b);
  let bx = ua.x + ub.x, by = ua.y + ub.y;
  const length = Math.hypot(bx, by);
  if (length < 1e-9) { bx = -ua.y; by = ua.x; }
  const norm = Math.hypot(bx, by) || 1;
  const distance = radius * 1.45;
  return { x: vertex.x + bx / norm * distance, y: vertex.y + by / norm * distance };
}

export interface AngleDecorations { p1: Pt; p2: Pt; p3: Pt; radius: number; arcPath: string; arcStroke: number; label: Pt; fontSize: number; degrees: number }

/**
 * Every derived number the protractor draws: arc radius, arc stroke, readout
 * position and type size. The interactive renderer and the export rasteriser
 * must draw the same protractor, so neither may restate these formulas.
 */
export function angleDecorations(
  shape: { x1: number; y1: number; x2: number; y2: number; x3?: number; y3?: number },
  width: number, height: number, strokeWidth: number,
): AngleDecorations {
  const { p1, p2, p3 } = shapePixelPoints(shape, width, height);
  const radius = Math.max(strokeWidth * 3,
    Math.min(Math.hypot(p2.x - p1.x, p2.y - p1.y), Math.hypot(p3.x - p1.x, p3.y - p1.y)) * 0.35);
  return {
    p1, p2, p3, radius,
    arcPath: angleArcPath(p1, p2, p3, radius),
    arcStroke: Math.max(1, strokeWidth * 0.6),
    label: angleLabelPoint(p1, p2, p3, radius),
    fontSize: Math.max(strokeWidth * 5, height * 0.032),
    degrees: angleDegrees(p1, p2, p3),
  };
}
