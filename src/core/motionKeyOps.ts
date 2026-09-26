/**
 * motionKeyOps — キーフレーム（Motion.keys）の「打つ・動かす・消す」純ロジック（F-1）。
 *
 * UI（MotionSettings / KeyframeList）はこの関数群だけを呼ぶ。React に依存しないので
 * 単体テストで挙動を固定でき、Undo/Redo は既存の EditState 差し替えにそのまま乗る。
 */
import { clampMotionState, resolveMotion, sampleMotion, type Motion, type MotionBase, type MotionKey } from './motion';

/** MotionKey の値軸（t 以外）。 */
export type MotionKeyAxis = 'x' | 'y' | 'scale' | 'opacity' | 'rotation';

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

function sorted(keys: MotionKey[]): MotionKey[] {
  return [...keys].sort((a, b) => a.t - b.t);
}

/** MotionBase を全軸指定の MotionKey へ。 */
function keyFromState(t: number, s: MotionBase): MotionKey {
  return { t, x: s.x, y: s.y, scale: s.scale, opacity: s.opacity, rotation: s.rotation };
}

/**
 * キーフレーム編集モードへ切り替える。
 * 既存のプリセット（2点アニメ）は**解決済みの開始/終了**を t=0 / t=1 の 2 点として引き継ぐので、
 * 切り替えた瞬間に絵が変わらない。motion 無しなら base の値で 2 点を置く。
 */
export function toKeyframeMotion(motion: Motion | undefined, base: MotionBase): Motion {
  if (motion?.keys !== undefined && motion.keys.length > 0) return motion;
  const { from, to } = motion
    ? resolveMotion(motion, base)
    : { from: clampMotionState(base), to: clampMotionState(base) };
  return { preset: 'keyframes', keys: [keyFromState(0, from), keyFromState(1, to)] };
}

/**
 * 進行度 t にキーを打つ。値は**その時点の現在の見た目**（補間値）なので、打った瞬間に絵は変わらない。
 * 同じ t のキーが既にあれば何もしない。
 */
export function addMotionKey(motion: Motion, t: number, base: MotionBase): Motion {
  const at = clamp01(t);
  const keys = motion.keys ?? [];
  if (keys.some((k) => k.t === at)) return motion;
  const state = sampleMotion(motion, base, at);
  return { ...motion, preset: 'keyframes', keys: sorted([...keys, keyFromState(at, state)]) };
}

/**
 * index のキーを進行度 t へ動かす（0..1 クランプ）。
 *
 * **並べ替えない**（F-1 ラウンド2 差し戻し・minor）。UI は配列 index で操作対象を指しているため、
 * ここで昇順へ並べ直すと「他のキーを追い越した瞬間に、掴んでいたスライダーが別のキーを動かし始める」。
 * 補間側（sampleMotionKeys とその複製）は評価のたびに自分で昇順化するので、保持順は自由でよい。
 * 表示の並びは KeyframeList が時間順に並べ替えて見せる（データの保持順は触らない）。
 */
export function moveMotionKey(motion: Motion, index: number, t: number): Motion {
  const keys = motion.keys ?? [];
  const target = keys[index];
  if (target === undefined) return motion;
  return { ...motion, keys: keys.map((k, i) => (i === index ? { ...k, t: clamp01(t) } : k)) };
}

/** index のキーを消す。最後の 1 点を消したら motion 自体を外す（undefined）。 */
export function removeMotionKey(motion: Motion, index: number): Motion | undefined {
  const keys = motion.keys ?? [];
  if (keys[index] === undefined) return motion;
  const next = keys.filter((_, i) => i !== index);
  if (next.length === 0) return undefined;
  return { ...motion, keys: next };
}

/** index のキーの 1 軸だけ差し替える。 */
export function setMotionKeyAxis(motion: Motion, index: number, axis: MotionKeyAxis, value: number): Motion {
  const keys = motion.keys ?? [];
  if (keys[index] === undefined) return motion;
  return { ...motion, keys: keys.map((k, i) => (i === index ? { ...k, [axis]: value } : k)) };
}
