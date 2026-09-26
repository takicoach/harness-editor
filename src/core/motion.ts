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

export type MotionPreset = 'zoomIn' | 'zoomOut' | 'panLeft' | 'panRight' | 'fadeIn' | 'custom' | 'keyframes';

/**
 * キーフレーム 1 点（F-1）。`t` は表示区間内の進行度 0..1（motionProgress と同じ時間軸）。
 * 指定しない軸は要素の基本値（MotionBase）を使う＝from/to と同じ部分指定の意味論。
 */
export interface MotionKey extends MotionState {
  /** 区間内の進行度 0..1。配列は t 昇順（sampleMotion 側でも昇順化する）。 */
  t: number;
}

/** テロップ / 画像に付ける 2点アニメ指定（telopData / insertImageData へそのまま保存）。 */
export interface Motion {
  preset: MotionPreset;
  /** 動きの強さ 0..1（既定 0.5）。custom では未使用。 */
  intensity?: number;
  /** 開始状態の上書き（詳細設定）。 */
  from?: MotionState;
  /** 終了状態の上書き（詳細設定）。 */
  to?: MotionState;
  /**
   * キーフレーム列（F-1・任意）。1 点以上あるとき **preset / intensity / from / to より優先**し、
   * 区間内進行度 t で連続補間する（隣接キー間は easeInOutCubic・端の外側は端の値で固定）。
   * 空配列・未指定なら従来の 2 点アニメ挙動と完全に同一。
   */
  keys?: MotionKey[];
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
export type MotionPositionPolicy = 'bounded' | 'finite';

/** Preserve finite graphic coordinates; keep the legacy arithmetic unchanged by default. */
export function interpolatePosition(a:number,b:number,t:number,policy:MotionPositionPolicy='bounded'):number {
  if(policy==='bounded')return a+(b-a)*t;
  if(t===0)return a;
  if(t===1)return b;
  return Math.sign(a)!==Math.sign(b)?a*(1-t)+b*t:a+(b-a)*t;
}
export function clampMotionState(s: MotionBase, positionPolicy:MotionPositionPolicy='bounded'): MotionBase {
  if(positionPolicy==='finite'&&(!Number.isFinite(s.x)||!Number.isFinite(s.y)))throw new Error('レイヤーの位置は有限の数値で指定してください。');
  return {
    x: positionPolicy==='finite'?s.x:clamp(s.x, -1.5, 1.5),
    y: positionPolicy==='finite'?s.y:clamp(s.y, -1.5, 1.5),
    scale: clamp(s.scale, 0.05, 8),
    opacity: clamp(s.opacity, 0, 1),
    rotation: clamp(s.rotation, -360, 360),
  };
}

/** プリセット＋強さ＋詳細上書きを、絶対値の開始/終了状態へ解決する。 */
export function resolveMotion(motion: Motion, base: MotionBase, positionPolicy:MotionPositionPolicy='bounded'): { from: MotionBase; to: MotionBase } {
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
    case 'keyframes':
      // キーフレーム指定（keys）が本体。keys 不在なら base のまま＝無変化。
      break;
  }
  from = { ...from, ...pruneUndefined(motion.from) };
  to = { ...to, ...pruneUndefined(motion.to) };
  return { from: clampMotionState(from,positionPolicy), to: clampMotionState(to,positionPolicy) };
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

/** キー 1 点を base で補完した絶対状態へ解決する（未指定軸は base）。 */
function resolveKey(key: MotionKey, base: MotionBase, positionPolicy:MotionPositionPolicy): MotionBase {
  return clampMotionState({
    x: key.x ?? base.x,
    y: key.y ?? base.y,
    scale: key.scale ?? base.scale,
    opacity: key.opacity ?? base.opacity,
    rotation: key.rotation ?? base.rotation,
  },positionPolicy);
}

/**
 * キーフレーム列の進行度 progress における表示状態（F-1）。
 * - 最初のキーより前 / 最後のキーより後は、その端のキーの値で固定する
 * - 隣接キー間は区間内進行度を easeInOutCubic で補間する（従来の 2 点アニメと同じイージング）
 * - t が同値のキーが並ぶ場合、進行度がちょうどその t のときは**先のキー**（昇順で前）の値。
 *   t を超えた直後から後のキーを起点に補間する（＝タイの位置で値が瞬時に切り替わる）
 *
 * この関数がプレビュー（EditorComposition）・高速書き出しの撮影（capturePage）・
 * 書き出し部品（telopPack / project-template）の**共通の正典**。複製側は同式を自己完結で持ち、
 * パリティテスト（src/server/motionKeyframeParity.test.ts）が値の一致を機械的に固定する。
 */
export function sampleMotionKeys(keys: MotionKey[], base: MotionBase, progress: number, positionPolicy:MotionPositionPolicy='bounded'): MotionBase {
  if (keys.length === 0) return clampMotionState(base,positionPolicy);
  const sorted = [...keys].sort((a, b) => a.t - b.t);
  const p = clamp(progress, 0, 1);
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  if (p <= first.t) return resolveKey(first, base,positionPolicy);
  if (p >= last.t) return resolveKey(last, base,positionPolicy);
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i]!;
    const b = sorted[i + 1]!;
    if (p >= a.t && p <= b.t) {
      const span = b.t - a.t;
      const local = span <= 0 ? 1 : (p - a.t) / span;
      const t = easeInOutCubic(local);
      const sa = resolveKey(a, base,positionPolicy);
      const sb = resolveKey(b, base,positionPolicy);
      return clampMotionState({
        x: interpolatePosition(sa.x,sb.x,t,positionPolicy),
        y: interpolatePosition(sa.y,sb.y,t,positionPolicy),
        scale: sa.scale + (sb.scale - sa.scale) * t,
        opacity: sa.opacity + (sb.opacity - sa.opacity) * t,
        rotation: sa.rotation + (sb.rotation - sa.rotation) * t,
      },positionPolicy);
    }
  }
  return resolveKey(last, base,positionPolicy);
}

/** 進行度に応じた表示状態を返す（motion 未指定は base のまま）。 */
export function sampleMotion(
  motion: Motion | undefined,
  base: MotionBase,
  progress: number,
  positionPolicy:MotionPositionPolicy='bounded',
): MotionBase {
  if (!motion) return clampMotionState(base,positionPolicy);
  if (motion.keys !== undefined && motion.keys.length > 0) {
    return sampleMotionKeys(motion.keys, base, progress,positionPolicy);
  }
  const { from, to } = resolveMotion(motion, base,positionPolicy);
  const t = easeInOutCubic(progress);
  return clampMotionState({
    x: interpolatePosition(from.x,to.x,t,positionPolicy),
    y: interpolatePosition(from.y,to.y,t,positionPolicy),
    scale: from.scale + (to.scale - from.scale) * t,
    opacity: from.opacity + (to.opacity - from.opacity) * t,
    rotation: from.rotation + (to.rotation - from.rotation) * t,
  },positionPolicy);
}

/** unknown 値を Motion として検証する（parse 用・不正は undefined）。 */
export function parseMotion(value: unknown): Motion | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const rec = value as Record<string, unknown>;
  const preset = rec['preset'];
  if (
    preset !== 'zoomIn' && preset !== 'zoomOut' && preset !== 'panLeft' &&
    preset !== 'panRight' && preset !== 'fadeIn' && preset !== 'custom' &&
    preset !== 'keyframes'
  ) return undefined;
  const motion: Motion = { preset };
  if (typeof rec['intensity'] === 'number') motion.intensity = clamp(rec['intensity'], 0, 1);
  const from = parseMotionState(rec['from']);
  const to = parseMotionState(rec['to']);
  if (from) motion.from = from;
  if (to) motion.to = to;
  const keys = parseMotionKeys(rec['keys']);
  if (keys) motion.keys = keys;
  return motion;
}

/** unknown 値を MotionKey[] として検証する（配列でない/有効キー 0 件は undefined・t 昇順へ整列）。 */
function parseMotionKeys(value: unknown): MotionKey[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: MotionKey[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const rec = item as Record<string, unknown>;
    const t = rec['t'];
    if (typeof t !== 'number' || !Number.isFinite(t)) continue;
    const key: MotionKey = { t: clamp(t, 0, 1) };
    const state = parseMotionState(rec);
    if (state) Object.assign(key, state);
    out.push(key);
  }
  if (out.length === 0) return undefined;
  return out.sort((a, b) => a.t - b.t);
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
  if (motion.keys && motion.keys.length > 0) {
    const keys = [...motion.keys]
      .sort((a, b) => a.t - b.t)
      .map((k) => formatMotionKey(k))
      .join(', ');
    parts.push(`keys: [${keys}]`);
  }
  return `{ ${parts.join(', ')} }`;
}

/** MotionKey をオブジェクトリテラル文字列へ（t を先頭・指定軸のみ）。 */
function formatMotionKey(k: MotionKey): string {
  const parts: string[] = [`t: ${k.t}`];
  for (const key of ['x', 'y', 'scale', 'opacity', 'rotation'] as const) {
    if (k[key] !== undefined) parts.push(`${key}: ${k[key]}`);
  }
  return `{ ${parts.join(', ')} }`;
}

function formatMotionState(s: MotionState): string {
  const parts: string[] = [];
  for (const key of ['x', 'y', 'scale', 'opacity', 'rotation'] as const) {
    if (s[key] !== undefined) parts.push(`${key}: ${s[key]}`);
  }
  return `{ ${parts.join(', ')} }`;
}
