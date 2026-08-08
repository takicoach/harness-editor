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
 * 図形の 2 点を平行移動する（dx, dy を加算・各 0..1 クランプ）。
 * 非有限値・不在 ID は state をそのまま返す。
 */
export function moveShape(state: EditState, id: number, dx: number, dy: number): EditState {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return state;
  return patchShape(state, id, (s) => ({
    ...s,
    x1: clamp01(s.x1 + dx),
    y1: clamp01(s.y1 + dy),
    x2: clamp01(s.x2 + dx),
    y2: clamp01(s.y2 + dy),
  }));
}

/**
 * 図形の 2 点座標を直接設定する（各 0..1 クランプ）。
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
  return patchShape(state, id, (s) => ({
    ...s,
    x1: clamp01(x1),
    y1: clamp01(y1),
    x2: clamp01(x2),
    y2: clamp01(y2),
  }));
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
