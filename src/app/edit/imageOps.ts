import type { EditorImage, ElementAnim, ImageType, TelopPosition } from '../../core/types';
import type { EditState } from './editState';

/** 新規画像の既定再生長（フレーム）。ハーネス形式の挿入画像は 60fps で 2 秒相当。 */
const DEFAULT_IMAGE_DURATION_FRAMES = 120;

/**
 * 挿入画像を originalStart（原本フレーム）から既定長で追加し、その画像を選択状態にする。
 * file が空・originalStart が非有限なら state をそのまま返す。
 * originalStart は 0 以上へクランプし丸める。type は 'photo'、scale は未指定（既定 1）。
 */
export function addImage(state: EditState, file: string, originalStart: number): EditState {
  if (file === '' || !Number.isFinite(originalStart)) return state;
  const start = Math.max(0, Math.round(originalStart));
  const image: EditorImage = {
    id: state.nextImageId,
    originalStart: start,
    originalEnd: start + DEFAULT_IMAGE_DURATION_FRAMES,
    file,
    type: 'photo',
  };
  return {
    ...state,
    images: [...state.images, image],
    nextImageId: state.nextImageId + 1,
    selection: { kind: 'image', id: image.id },
  };
}

/**
 * 指定 ID の画像を取り除く。不在 ID なら state をそのまま返す。
 * 削除した画像が選択中なら選択を外す。
 */
export function removeImage(state: EditState, imageId: number): EditState {
  if (!state.images.some((i) => i.id === imageId)) return state;
  const selection =
    state.selection?.kind === 'image' && state.selection.id === imageId
      ? null
      : state.selection;
  return { ...state, images: state.images.filter((i) => i.id !== imageId), selection };
}

/** 指定 ID の画像を選択状態にする。 */
export function selectImage(state: EditState, imageId: number): EditState {
  return { ...state, selection: { kind: 'image', id: imageId } };
}

/** 数値を [min,max] へクランプする。 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 指定 ID の画像へ patch を適用するヘルパ（不在 ID はそのまま）。 */
function patchImage(
  state: EditState,
  imageId: number,
  patch: (i: EditorImage) => EditorImage,
): EditState {
  // some() で不在 ID を早期 return（同一参照を保つ）→ map() で実際の更新を行う。
  if (!state.images.some((i) => i.id === imageId)) return state;
  return { ...state, images: state.images.map((i) => (i.id === imageId ? patch(i) : i)) };
}

/**
 * 画像区間を平行移動する。長さは保ったまま originalStart を変える。
 * 0 以上クランプ・丸め。非有限値・不在 ID は state をそのまま返す。
 */
export function moveImage(state: EditState, imageId: number, originalStart: number): EditState {
  if (!Number.isFinite(originalStart)) return state;
  const newStart = Math.max(0, Math.round(originalStart));
  return patchImage(state, imageId, (i) => {
    const duration = i.originalEnd - i.originalStart;
    return { ...i, originalStart: newStart, originalEnd: newStart + duration };
  });
}

/**
 * 画像区間の開始・終了を独立に設定する（つまみドラッグ・インスペクタ数値入力用）。
 * 0 以上クランプ・丸め。end <= start なら最小 1 フレーム差で end を強制。
 * 非有限値・不在 ID は state をそのまま返す。
 */
export function retimeImage(
  state: EditState,
  imageId: number,
  originalStart: number,
  originalEnd: number,
): EditState {
  if (!Number.isFinite(originalStart) || !Number.isFinite(originalEnd)) return state;
  const start = Math.max(0, Math.round(originalStart));
  const end = Math.max(start + 1, Math.round(originalEnd));
  return patchImage(state, imageId, (i) => ({ ...i, originalStart: start, originalEnd: end }));
}

/**
 * 画像のスケールを設定する（0.1..5 へクランプ）。
 * 非有限値・不在 ID は state をそのまま返す。
 * TODO(M5): インスペクタのスライダ min/max は必ずここのクランプ範囲 [0.1, 5] と一致させること。
 */
export function setImageScale(state: EditState, imageId: number, scale: number): EditState {
  if (!Number.isFinite(scale)) return state;
  return patchImage(state, imageId, (i) => ({ ...i, scale: clamp(scale, 0.1, 5) }));
}

/** 画像の position を設定（x,y を -1..1 へクランプ）。非有限・不在 ID はそのまま。 */
export function setImagePosition(state: EditState, imageId: number, x: number, y: number): EditState {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return state;
  const position: TelopPosition = { x: clamp(x, -1, 1), y: clamp(y, -1, 1) };
  return patchImage(state, imageId, (i) => ({ ...i, position }));
}

/**
 * 画像タイプを差し替える（'photo' | 'infographic' | 'overlay'）。
 * 不在 ID は state をそのまま返す。
 */
export function setImageType(state: EditState, imageId: number, type: ImageType): EditState {
  return patchImage(state, imageId, (i) => ({ ...i, type }));
}

/**
 * 画像ファイルを差し替える。
 * 空文字・不在 ID は state をそのまま返す。
 */
export function setImageFile(state: EditState, imageId: number, file: string): EditState {
  if (file === '') return state;
  return patchImage(state, imageId, (i) => ({ ...i, file }));
}

/** 画像の不透明度を設定（0..1 へクランプ）。非有限・不在 ID はそのまま。 */
export function setImageOpacity(state: EditState, imageId: number, opacity: number): EditState {
  if (!Number.isFinite(opacity)) return state;
  return patchImage(state, imageId, (i) => ({ ...i, opacity: clamp(opacity, 0, 1) }));
}

/** 画像の回転角（度）を設定（-180..180 へクランプ）。非有限・不在 ID はそのまま。 */
export function setImageRotation(state: EditState, imageId: number, rotation: number): EditState {
  if (!Number.isFinite(rotation)) return state;
  return patchImage(state, imageId, (i) => ({ ...i, rotation: clamp(rotation, -180, 180) }));
}

/** 画像の 2点アニメを設定する（undefined で解除）。不在 ID はそのまま。 */
export function setImageMotion(
  state: EditState,
  imageId: number,
  motion: import('../../core/motion').Motion | undefined,
): EditState {
  return patchImage(state, imageId, (i) => {
    const next = { ...i };
    if (motion === undefined) delete next.motion;
    else next.motion = motion;
    return next;
  });
}

/** 画像の登場アニメを設定する。不在 ID はそのまま。 */
export function setImageEnter(state: EditState, imageId: number, enter: ElementAnim): EditState {
  return patchImage(state, imageId, (i) => ({ ...i, enter }));
}

/** 画像の退場アニメを設定する。不在 ID はそのまま。 */
export function setImageExit(state: EditState, imageId: number, exit: ElementAnim): EditState {
  return patchImage(state, imageId, (i) => ({ ...i, exit }));
}
