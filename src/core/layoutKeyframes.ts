/**
 * layoutKeyframes — メイン動画の大域キーフレーム列（カット非依存・原本フレームアンカー）。
 *
 * 各キーフレームは原本フレーム（カット前タイム）にアンカーし、動画全体で1本の配列として
 * originalFrame 昇順に並ぶ。2 点以上あるとき、カット区間に縛られずメイン動画レイアウトを
 * 連続補間で駆動する（区間境界のリセットが無く、パンが滑らか）。
 */

import { clampLayoutPos, clampRotation } from './mainLayout';
import { easeInOutCubic } from './motion';

/** 1 キーフレーム（原本フレームアンカーの絶対値状態）。 */
export interface LayoutKeyframe {
  /** 原本（カット前）フレーム。非負整数。この配列は originalFrame 昇順。 */
  originalFrame: number;
  x: number;
  y: number;
  scale: number;
  rotation: number;
}

/** 補間結果（レイアウトの位置/大きさ/回転のみ）。 */
export interface LayoutSample {
  x: number;
  y: number;
  scale: number;
  rotation: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** キーフレーム値のクランプ（scale は上限 8 まで許容・originalFrame は非負整数）。 */
export function clampKeyframe(k: LayoutKeyframe): LayoutKeyframe {
  return {
    originalFrame: Math.max(0, Math.round(k.originalFrame)),
    x: clampLayoutPos(k.x),
    y: clampLayoutPos(k.y),
    scale: clamp(k.scale, 0.1, 8),
    rotation: clampRotation(k.rotation),
  };
}

/** originalFrame 昇順へソート（安定・同値は元順維持）。 */
function sortByFrame(ks: LayoutKeyframe[]): LayoutKeyframe[] {
  return [...ks].sort((a, b) => a.originalFrame - b.originalFrame);
}

/** unknown 値を LayoutKeyframe[] として検証する（配列でない/空は undefined・各要素は既定で補完）。 */
export function parse(value: unknown): LayoutKeyframe[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const out: LayoutKeyframe[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) return undefined;
    const rec = item as Record<string, unknown>;
    const of = typeof rec.originalFrame === 'number' && Number.isFinite(rec.originalFrame) ? rec.originalFrame : 0;
    const x = typeof rec.x === 'number' && Number.isFinite(rec.x) ? rec.x : 0;
    const y = typeof rec.y === 'number' && Number.isFinite(rec.y) ? rec.y : 0;
    const scale = typeof rec.scale === 'number' && Number.isFinite(rec.scale) ? rec.scale : 1;
    const rotation = typeof rec.rotation === 'number' && Number.isFinite(rec.rotation) ? rec.rotation : 0;
    out.push(clampKeyframe({ originalFrame: of, x, y, scale, rotation }));
  }
  return sortByFrame(out);
}

/** LayoutKeyframe[] を JS 配列リテラルへ（mainLayoutData.ts の生成ソースへ埋め込む用）。 */
export function format(keyframes: LayoutKeyframe[]): string {
  const items = sortByFrame(keyframes).map((k) => {
    const c = clampKeyframe(k);
    return `{ originalFrame: ${c.originalFrame}, x: ${c.x}, y: ${c.y}, scale: ${c.scale}, rotation: ${c.rotation} }`;
  });
  return `[${items.join(', ')}]`;
}

const IDENTITY: LayoutSample = { x: 0, y: 0, scale: 1, rotation: 0 };

function pick(k: LayoutKeyframe): LayoutSample {
  return { x: k.x, y: k.y, scale: k.scale, rotation: k.rotation };
}

function clampSample(s: LayoutSample): LayoutSample {
  return { x: clampLayoutPos(s.x), y: clampLayoutPos(s.y), scale: clamp(s.scale, 0.1, 8), rotation: clampRotation(s.rotation) };
}

/**
 * 原本フレーム originalFrame における補間状態を返す（keyframes は originalFrame 昇順・length>=1 前提）。
 * 最初のKFより前＝最初のKF値で固定、最後のKFより後＝最後のKF値で固定（動画全体に効く）。
 * 隣接KF間は easeInOutCubic。
 */
export function sampleAtOriginalFrame(keyframes: LayoutKeyframe[], originalFrame: number): LayoutSample {
  const ks = keyframes;
  if (ks.length === 0) return { ...IDENTITY };
  const first = ks[0]!;
  const last = ks[ks.length - 1]!;
  if (originalFrame <= first.originalFrame) return clampSample(pick(first));
  if (originalFrame >= last.originalFrame) return clampSample(pick(last));
  for (let i = 0; i < ks.length - 1; i++) {
    const a = ks[i]!;
    const b = ks[i + 1]!;
    if (originalFrame >= a.originalFrame && originalFrame <= b.originalFrame) {
      const span = b.originalFrame - a.originalFrame;
      const p = span <= 0 ? 1 : (originalFrame - a.originalFrame) / span;
      const t = easeInOutCubic(p);
      return clampSample({
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        scale: a.scale + (b.scale - a.scale) * t,
        rotation: a.rotation + (b.rotation - a.rotation) * t,
      });
    }
  }
  return clampSample(pick(last));
}
