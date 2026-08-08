/**
 * motion — 2点アニメ（開始→終了の補間）の純ロジック。
 *
 * テロップ・挿入画像の `motion` フィールドを解釈し、表示区間の進行度（0..1）に応じた
 * 位置/大きさ/不透明度/回転を返す。プリセット（ズームイン等）＋強さ intensity を
 * 具体的な開始/終了状態へ解決し、from/to の明示指定（詳細設定）はそれを上書きする。
 *
 * このモジュールはエディタ側の正典。プロジェクトへコピーされるテロップアダプタ
 * （src/server/telopPack/Telop.tsx）にも同じ式を自己完結で持たせている（telopLayout と同じ流儀）。
 */

/** アニメの端点状態。未指定の軸は要素の基本値を使う。 */
export interface MotionState {
  x?: number;
  y?: number;
  scale?: number;
  opacity?: number;
  rotation?: number;
}

export type MotionPreset = 'zoomIn' | 'zoomOut' | 'panLeft' | 'panRight' | 'fadeIn' | 'custom';

/** テロップ / 画像に付ける 2点アニメ指定（telopData / insertImageData へそのまま保存）。 */
export interface Motion {
  preset: MotionPreset;
  /** 動きの強さ 0..1（既定 0.5）。custom では未使用。 */
  intensity?: number;
  /** 開始状態の上書き（詳細設定）。 */
  from?: MotionState;
  /** 終了状態の上書き（詳細設定）。 */
  to?: MotionState;
}

/** 要素の基本状態（motion 未指定時の表示値）。 */
export interface MotionBase {
  x: number;
  y: number;
  scale: number;
  opacity: number;
  rotation: number;
}

export const DEFAULT_INTENSITY = 0.5;

/** ズームの最大変化率（intensity=1 で scale が 1.8 倍）。 */
const ZOOM_RANGE = 0.8;
/** パンの最大片振れ幅（intensity=1 で ±0.4 = 画面幅の 20%）。 */
const PAN_RANGE = 0.4;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** 状態のクランプ（変な組み合わせでも画面外へ吹き飛ばない安全弁）。 */
export function clampMotionState(s: MotionBase): MotionBase {
  return {
    x: clamp(s.x, -1.5, 1.5),
    y: clamp(s.y, -1.5, 1.5),
    scale: clamp(s.scale, 0.05, 8),
    opacity: clamp(s.opacity, 0, 1),
    rotation: clamp(s.rotation, -360, 360),
  };
}

/** プリセット＋強さ＋詳細上書きを、絶対値の開始/終了状態へ解決する。 */
export function resolveMotion(motion: Motion, base: MotionBase): { from: MotionBase; to: MotionBase } {
  const k = clamp(motion.intensity ?? DEFAULT_INTENSITY, 0, 1);
  let from: MotionBase = { ...base };
  let to: MotionBase = { ...base };
  switch (motion.preset) {
    case 'zoomIn':
      to = { ...to, scale: base.scale * (1 + ZOOM_RANGE * k) };
      break;
    case 'zoomOut':
      from = { ...from, scale: base.scale * (1 + ZOOM_RANGE * k) };
      break;
    case 'panLeft':
      from = { ...from, x: base.x + PAN_RANGE * k };
      to = { ...to, x: base.x - PAN_RANGE * k };
      break;
    case 'panRight':
      from = { ...from, x: base.x - PAN_RANGE * k };
      to = { ...to, x: base.x + PAN_RANGE * k };
      break;
    case 'fadeIn':
      from = { ...from, opacity: 0 };
      break;
    case 'custom':
      break;
  }
  from = { ...from, ...pruneUndefined(motion.from) };
  to = { ...to, ...pruneUndefined(motion.to) };
  return { from: clampMotionState(from), to: clampMotionState(to) };
}

function pruneUndefined(s: MotionState | undefined): Partial<MotionBase> {
  if (!s) return {};
  const out: Partial<MotionBase> = {};
  if (s.x !== undefined) out.x = s.x;
  if (s.y !== undefined) out.y = s.y;
  if (s.scale !== undefined) out.scale = s.scale;
  if (s.opacity !== undefined) out.opacity = s.opacity;
  if (s.rotation !== undefined) out.rotation = s.rotation;
  return out;
}

/** イーズイン/アウト（3次）。両端で滑らかに止まる。 */
export function easeInOutCubic(t: number): number {
  const x = clamp(t, 0, 1);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

/** 表示区間内の進行度 0..1（区間外はクランプ・縮退区間は 1）。 */
export function motionProgress(frame: number, startFrame: number, endFrame: number): number {
  const span = endFrame - startFrame;
  if (span <= 0) return 1;
  return clamp((frame - startFrame) / span, 0, 1);
}

/** 進行度に応じた表示状態を返す（motion 未指定は base のまま）。 */
export function sampleMotion(
  motion: Motion | undefined,
  base: MotionBase,
  progress: number,
): MotionBase {
  if (!motion) return clampMotionState(base);
  const { from, to } = resolveMotion(motion, base);
  const t = easeInOutCubic(progress);
  return clampMotionState({
    x: from.x + (to.x - from.x) * t,
    y: from.y + (to.y - from.y) * t,
    scale: from.scale + (to.scale - from.scale) * t,
    opacity: from.opacity + (to.opacity - from.opacity) * t,
    rotation: from.rotation + (to.rotation - from.rotation) * t,
  });
}

/** unknown 値を Motion として検証する（parse 用・不正は undefined）。 */
export function parseMotion(value: unknown): Motion | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const rec = value as Record<string, unknown>;
  const preset = rec['preset'];
  if (
    preset !== 'zoomIn' && preset !== 'zoomOut' && preset !== 'panLeft' &&
    preset !== 'panRight' && preset !== 'fadeIn' && preset !== 'custom'
  ) return undefined;
  const motion: Motion = { preset };
  if (typeof rec['intensity'] === 'number') motion.intensity = clamp(rec['intensity'], 0, 1);
  const from = parseMotionState(rec['from']);
  const to = parseMotionState(rec['to']);
  if (from) motion.from = from;
  if (to) motion.to = to;
  return motion;
}

function parseMotionState(value: unknown): MotionState | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const rec = value as Record<string, unknown>;
  const out: MotionState = {};
  for (const key of ['x', 'y', 'scale', 'opacity', 'rotation'] as const) {
    const v = rec[key];
    if (typeof v === 'number' && Number.isFinite(v)) out[key] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Motion をデータファイルの JS リテラル行へ整形する（serializeTelopData / insertImageData 用）。 */
export function formatMotion(motion: Motion): string {
  const parts: string[] = [`preset: "${motion.preset}"`];
  if (motion.intensity !== undefined) parts.push(`intensity: ${motion.intensity}`);
  if (motion.from) parts.push(`from: ${formatMotionState(motion.from)}`);
  if (motion.to) parts.push(`to: ${formatMotionState(motion.to)}`);
  return `{ ${parts.join(', ')} }`;
}

function formatMotionState(s: MotionState): string {
  const parts: string[] = [];
  for (const key of ['x', 'y', 'scale', 'opacity', 'rotation'] as const) {
    if (s[key] !== undefined) parts.push(`${key}: ${s[key]}`);
  }
  return `{ ${parts.join(', ')} }`;
}
