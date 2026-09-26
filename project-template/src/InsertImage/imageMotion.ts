/**
 * imageMotion — 挿入画像の 2 点アニメ／キーフレームアニメの補間（自己完結コピー）。
 *
 * SuperMovie Editor 本体 `src/core/motion.ts` と**同式**。プロジェクトは本体を import できない
 * ため式が複製されている。ドリフトはエディタ側のパリティテスト
 * （src/server/motionKeyframeParity.test.ts）が全フレーム走査で機械検出する。
 *
 * MOTION_KEYFRAMES_V1 — この部品がキーフレーム（motion.keys）に対応している目印。
 * エディタはこの文字列の有無で「書き出しにキーフレームが反映されるか」を判定して利用者へ伝える。
 */

/** アニメの端点状態（未指定の軸は要素の基本値）。 */
export interface MotionState {
  x?: number;
  y?: number;
  scale?: number;
  opacity?: number;
  rotation?: number;
}

/** キーフレーム 1 点（t は区間内進行度 0..1）。 */
export interface MotionKey extends MotionState {
  t: number;
}

export interface Motion {
  preset: 'zoomIn' | 'zoomOut' | 'panLeft' | 'panRight' | 'fadeIn' | 'custom' | 'keyframes';
  intensity?: number;
  from?: MotionState;
  to?: MotionState;
  /** キーフレーム列（1 点以上あれば preset/from/to より優先）。 */
  keys?: MotionKey[];
}

/** 補間結果（画像は回転も使う）。 */
export interface MotionFull {
  x: number;
  y: number;
  scale: number;
  opacity: number;
  rotation: number;
}

function mclamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export function clampMotionFull(s: MotionFull): MotionFull {
  return {
    x: mclamp(s.x, -1.5, 1.5),
    y: mclamp(s.y, -1.5, 1.5),
    scale: mclamp(s.scale, 0.05, 8),
    opacity: mclamp(s.opacity, 0, 1),
    rotation: mclamp(s.rotation, -360, 360),
  };
}

/** プリセット＋強さ＋詳細上書き → 絶対値の開始/終了状態。 */
function resolveEndpoints(motion: Motion, base: MotionFull): { from: MotionFull; to: MotionFull } {
  const k = mclamp(motion.intensity ?? 0.5, 0, 1);
  const ZOOM_RANGE = 0.8;
  const PAN_RANGE = 0.4;
  let from: MotionFull = { ...base };
  let to: MotionFull = { ...base };
  if (motion.preset === 'zoomIn') to = { ...to, scale: base.scale * (1 + ZOOM_RANGE * k) };
  if (motion.preset === 'zoomOut') from = { ...from, scale: base.scale * (1 + ZOOM_RANGE * k) };
  if (motion.preset === 'panLeft') { from = { ...from, x: base.x + PAN_RANGE * k }; to = { ...to, x: base.x - PAN_RANGE * k }; }
  if (motion.preset === 'panRight') { from = { ...from, x: base.x - PAN_RANGE * k }; to = { ...to, x: base.x + PAN_RANGE * k }; }
  if (motion.preset === 'fadeIn') from = { ...from, opacity: 0 };
  const apply = (target: MotionFull, o: MotionState | undefined): MotionFull => ({
    x: o?.x ?? target.x,
    y: o?.y ?? target.y,
    scale: o?.scale ?? target.scale,
    opacity: o?.opacity ?? target.opacity,
    rotation: o?.rotation ?? target.rotation,
  });
  return { from: clampMotionFull(apply(from, motion.from)), to: clampMotionFull(apply(to, motion.to)) };
}

/** イーズイン/アウト（3次）。 */
function ease(t: number): number {
  const x = mclamp(t, 0, 1);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

function resolveKey(key: MotionKey, base: MotionFull): MotionFull {
  return clampMotionFull({
    x: key.x ?? base.x,
    y: key.y ?? base.y,
    scale: key.scale ?? base.scale,
    opacity: key.opacity ?? base.opacity,
    rotation: key.rotation ?? base.rotation,
  });
}

/** キーフレーム列を進行度 p（0..1）でサンプルする（端の外側は端の値で固定）。 */
export function sampleKeys(keys: MotionKey[], base: MotionFull, progress: number): MotionFull {
  if (keys.length === 0) return clampMotionFull(base);
  const sorted = [...keys].sort((a, b) => a.t - b.t);
  const p = mclamp(progress, 0, 1);
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  if (p <= first.t) return resolveKey(first, base);
  if (p >= last.t) return resolveKey(last, base);
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i]!;
    const b = sorted[i + 1]!;
    if (p >= a.t && p <= b.t) {
      const span = b.t - a.t;
      const t = ease(span <= 0 ? 1 : (p - a.t) / span);
      const sa = resolveKey(a, base);
      const sb = resolveKey(b, base);
      return clampMotionFull({
        x: sa.x + (sb.x - sa.x) * t,
        y: sa.y + (sb.y - sa.y) * t,
        scale: sa.scale + (sb.scale - sa.scale) * t,
        opacity: sa.opacity + (sb.opacity - sa.opacity) * t,
        rotation: sa.rotation + (sb.rotation - sa.rotation) * t,
      });
    }
  }
  return resolveKey(last, base);
}

/**
 * 区間相対フレーム localFrame（<Sequence> 内の 0 始まり）における表示状態。
 * duration は区間長（endFrame - startFrame）。
 */
export function sampleImageMotion(
  motion: Motion,
  base: MotionFull,
  localFrame: number,
  duration: number,
): MotionFull {
  const p = duration <= 0 ? 1 : mclamp(localFrame / duration, 0, 1);
  if (motion.keys !== undefined && motion.keys.length > 0) return sampleKeys(motion.keys, base, p);
  const { from, to } = resolveEndpoints(motion, base);
  const t = ease(p);
  return clampMotionFull({
    x: from.x + (to.x - from.x) * t,
    y: from.y + (to.y - from.y) * t,
    scale: from.scale + (to.scale - from.scale) * t,
    opacity: from.opacity + (to.opacity - from.opacity) * t,
    rotation: from.rotation + (to.rotation - from.rotation) * t,
  });
}
