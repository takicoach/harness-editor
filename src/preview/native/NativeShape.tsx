import type { CSSProperties, ReactNode } from 'react';
import { shapeSvgGeometry, thicknessToPx, fadeOpacity } from '../../core/shapeStyle';
import { angleDecorations, trianglePoints } from '../../core/shapeGeometry';
import type { ShapeFill } from '../../core/sequence/model';
import type { PlannedVisual } from '../../core/sequence/scenePlan';

const fill: CSSProperties = { position: 'absolute', inset: 0, width: '100%', height: '100%' };
function FillGradient({ id, paint }: { id: string; paint: Extract<ShapeFill, { kind: 'linear' }> }) {
  return <linearGradient id={id} gradientTransform={`rotate(${paint.angle} .5 .5)`}>
    {paint.stops.map((stop, index) => <stop key={index} offset={stop.offset} stopColor={stop.color} />)}
  </linearGradient>;
}
/** 図形。塗り・線の太さ（px）・角丸は任意項目で、無ければ従来の線だけの図形になる。 */
export function NativeShape({ visual, width, height }: { visual: PlannedVisual; width: number; height: number }) {
  if (visual.clip.content.kind !== 'shape') return null;
  const content = visual.clip.content, shape = content.data, g = shapeSvgGeometry(shape, width, height);
  const stroke = content.strokeWidth ?? thicknessToPx(shape.thickness, height), strokePaint = content.strokeWidth === 0 ? 'none' : shape.color;
  const fillId = `native-fill-${visual.clip.id}`, paint = !content.fill ? 'none' : content.fill.kind === 'solid' ? content.fill.color : `url(#${fillId})`;
  const radius = content.cornerRadius;
  const arrow = `native-arrow-${visual.clip.id}`;
  const explicit=visual.clip.visual?.enter||visual.clip.visual?.exit;
  const opacity=(shape.opacity ?? 1) * (explicit?1:fadeOpacity(visual.effectFrame, visual.effectDuration, 8));
  let body: ReactNode;
  if (shape.kind === 'arrow' || shape.kind === 'line') {
    body = <line x1={g.x1} y1={g.y1} x2={g.x2} y2={g.y2} stroke={strokePaint} strokeWidth={stroke} strokeLinecap="round" markerEnd={shape.kind === 'arrow' ? `url(#${arrow})` : undefined} />;
  } else if (shape.kind === 'rect') {
    body = <rect data-native-shape-box x={g.rectX} y={g.rectY} width={g.rectW} height={g.rectH} rx={radius} ry={radius} stroke={strokePaint} strokeWidth={stroke} fill={paint} strokeLinejoin="round" />;
  } else if (shape.kind === 'triangle') {
    const points = trianglePoints(g.x1, g.y1, g.x2, g.y2);
    body = <polygon data-native-shape-box points={points.map(p => `${p.x},${p.y}`).join(' ')} stroke={strokePaint} strokeWidth={stroke} fill={paint} strokeLinejoin="round" />;
  } else if (shape.kind === 'angle') {
    // 装飾の式は core/shapeGeometry が正本。書き出し側（server/shapeRaster）と同じ関数を呼ぶ。
    const { p1, p2, p3, arcPath, arcStroke, label, fontSize, degrees } = angleDecorations(shape, width, height, stroke);
    body = <g>
      <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} stroke={shape.color} strokeWidth={stroke} strokeLinecap="round" />
      <line x1={p1.x} y1={p1.y} x2={p3.x} y2={p3.y} stroke={shape.color} strokeWidth={stroke} strokeLinecap="round" />
      <path d={arcPath} stroke={shape.color} strokeWidth={arcStroke} fill="none" />
      <text data-native-angle-readout x={label.x} y={label.y} fill={shape.color} textAnchor="middle" dominantBaseline="middle"
        style={{ fontSize: `${fontSize}px`, fontWeight: 700 }}>
        {degrees.toFixed(1)}°
      </text>
    </g>;
  } else {
    body = <ellipse data-native-shape-box cx={g.cx} cy={g.cy} rx={g.rx} ry={g.ry} stroke={strokePaint} strokeWidth={stroke} fill={paint} />;
  }
  return <svg viewBox={`0 0 ${width} ${height}`} style={{ ...fill, opacity }}>
    <defs><marker id={arrow} markerWidth="3" markerHeight="3" refX="3" refY="1.5" orient="auto"><polygon points="0 0, 3 1.5, 0 3" fill={shape.color} /></marker>
      {content.fill?.kind === 'linear' && <FillGradient id={fillId} paint={content.fill} />}</defs>
    {body}
  </svg>;
}
