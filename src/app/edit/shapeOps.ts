import type { EditorShape, ShapeKind, ShapeThickness } from '../../core/types';
import { DEFAULT_SHAPE_COLOR } from '../../core/shapeStyle';
import type { EditState } from './editState';

/** 新規図形の既定再生長（フレーム）。 */
const DEFAULT_SHAPE_DURATION_FRAMES = 120;

/** 数値を [min,max] へクランプする。 */
function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** 数値を 0..1 へクランプする。 */
function clamp01(v: number): number {
  return clamp(v, 0, 1);
}

/** 指定 ID の図形へ patch を適用するヘルパ（不在 ID はそのまま）。 */
function patchShape(
  state: EditState,
  id: number,
  patch: (s: EditorShape) => EditorShape,
): EditState {
  if (!state.shapes.some((s) => s.id === id)) return state;
  return { ...state, shapes: state.shapes.map((s) => (s.id === id ? patch(s) : s)) };
}

/**
 * 図形を originalStart（原本フレーム）から既定長で追加し、その図形を選択状態にする。
 * x1/y1/x2/y2 は 0..1 へクランプ。originalStart は 0 以上へクランプし丸める。
 * 非有限値が含まれる場合は state をそのまま返す。
 * 既定色は DEFAULT_SHAPE_COLOR（赤）、既定太さは 'medium'。
 */
export function addShape(
  state: EditState,
  kind: ShapeKind,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  originalStart: number,
): EditState {
  if (![x1, y1, x2, y2, originalStart].every(Number.isFinite)) return state;
  const start = Math.max(0, Math.round(originalStart));
  const shape: EditorShape = {
    id: state.nextShapeId,
    originalStart: start,
    originalEnd: start + DEFAULT_SHAPE_DURATION_FRAMES,
    kind,
    x1: clamp01(x1),
    y1: clamp01(y1),
    x2: clamp01(x2),
    y2: clamp01(y2),
    color: DEFAULT_SHAPE_COLOR,
    thickness: 'medium',
  };
  return {
    ...state,
    shapes: [...state.shapes, shape],
    nextShapeId: state.nextShapeId + 1,
    selection: { kind: 'shape', id: shape.id },
  };
}

/**
 * 指定 ID の図形を取り除く。不在 ID なら state をそのまま返す。
 * 削除した図形が選択中なら選択を外す。
 */
export function removeShape(state: EditState, id: number): EditState {
  if (!state.shapes.some((s) => s.id === id)) return state;
  const selection =
    state.selection?.kind === 'shape' && state.selection.id === id
      ? null
      : state.selection;
  return { ...state, shapes: state.shapes.filter((s) => s.id !== id), selection };
}

/** 指定 ID の図形を選択状態にする。 */
export function selectShape(state: EditState, id: number): EditState {
  return { ...state, selection: { kind: 'shape', id } };
}

/**
 * 図形の 2 点を平行移動する。
 *
 * **端点を独立にクランプしない**（裁定 P1-8）。端点ごとに 0..1 クランプすると、境界に当たった
 * 側だけが止まって図形が変形する（線が縮む・矩形が潰れる）。ここでは図形全体として許される
 * dx/dy を先に求め、**両端点へ同量を当てて平行移動を常に保つ**。
 * 動ける余地が無い（実質 0 移動）なら**同一 state 参照**を返す（空の Undo を積まない）。
 * 非有限値・不在 ID は state をそのまま返す。
 */
export function moveShape(state: EditState, id: number, dx: number, dy: number): EditState {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return state;
  const s = state.shapes.find((x) => x.id === id);
  if (s === undefined) return state;
  const minX = Math.min(s.x1, s.x2);
  const maxX = Math.max(s.x1, s.x2);
  const minY = Math.min(s.y1, s.y2);
  const maxY = Math.max(s.y1, s.y2);
  // 左へは -minX まで、右へは 1-maxX まで（上下も同様）。
  const adx = clamp(dx, -minX, 1 - maxX);
  const ady = clamp(dy, -minY, 1 - maxY);
  if (adx === 0 && ady === 0) return state;
  return patchShape(state, id, (t) => ({
    ...t,
    x1: clamp01(t.x1 + adx),
    y1: clamp01(t.y1 + ady),
    x2: clamp01(t.x2 + adx),
    y2: clamp01(t.y2 + ady),
  }));
}

/**
 * 図形の 2 点座標を直接設定する（各 0..1 クランプ）。
 * ハンドルドラッグの経路（プレビューのリサイズ）はここを通る。
 * クランプ後の 4 点が現在値と同値なら**同一 state 参照**を返す（no-op を commit しない）。
 * 非有限値・不在 ID は state をそのまま返す。
 */
export function setShapePoints(
  state: EditState,
  id: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): EditState {
  if (![x1, y1, x2, y2].every(Number.isFinite)) return state;
  const cur = state.shapes.find((s) => s.id === id);
  if (cur === undefined) return state;
  const nx1 = clamp01(x1);
  const ny1 = clamp01(y1);
  const nx2 = clamp01(x2);
  const ny2 = clamp01(y2);
  if (cur.x1 === nx1 && cur.y1 === ny1 && cur.x2 === nx2 && cur.y2 === ny2) return state;
  return patchShape(state, id, (s) => ({ ...s, x1: nx1, y1: ny1, x2: nx2, y2: ny2 }));
}

/**
 * 図形の表示区間を設定する（つまみドラッグ・インスペクタ数値入力用）。
 * 0 以上クランプ・丸め。end <= start なら最小 1 フレーム差で end を強制。
 * 非有限値・不在 ID は state をそのまま返す。
 */
export function retimeShape(
  state: EditState,
  id: number,
  originalStart: number,
  originalEnd: number,
): EditState {
  if (!Number.isFinite(originalStart) || !Number.isFinite(originalEnd)) return state;
  const start = Math.max(0, Math.round(originalStart));
  const end = Math.max(start + 1, Math.round(originalEnd));
  return patchShape(state, id, (s) => ({ ...s, originalStart: start, originalEnd: end }));
}

/**
 * 図形区間を平行移動する。長さは保ったまま originalStart を変える。
 * 0 以上クランプ・丸め。非有限値・不在 ID は state をそのまま返す。
 */
export function moveShapeTime(state: EditState, id: number, originalStart: number): EditState {
  if (!Number.isFinite(originalStart)) return state;
  const newStart = Math.max(0, Math.round(originalStart));
  return patchShape(state, id, (s) => {
    const duration = s.originalEnd - s.originalStart;
    return { ...s, originalStart: newStart, originalEnd: newStart + duration };
  });
}

/**
 * 図形の色を設定する。空文字・不在 ID は state をそのまま返す。
 */
export function setShapeColor(state: EditState, id: number, color: string): EditState {
  if (color === '') return state;
  return patchShape(state, id, (s) => ({ ...s, color }));
}

/**
 * 図形の線の太さを設定する（'thin' | 'medium' | 'thick'）。
 * 不在 ID は state をそのまま返す。
 */
export function setShapeThickness(state: EditState, id: number, thickness: ShapeThickness): EditState {
  return patchShape(state, id, (s) => ({ ...s, thickness }));
}

/**
 * 図形の不透明度を設定する（0..1 へクランプ）。
 * 非有限値・不在 ID は state をそのまま返す。
 */
export function setShapeOpacity(state: EditState, id: number, opacity: number): EditState {
  if (!Number.isFinite(opacity)) return state;
  return patchShape(state, id, (s) => ({ ...s, opacity: clamp(opacity, 0, 1) }));
}
