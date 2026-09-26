import { DEFAULT_MAIN_LAYOUT } from '../../core/mainLayout';
import { clampLayoutPos, clampRotation } from '../../core/mainLayout';
import { playbackFrameToOriginal } from '../../core/segmentLayout';
import { sampleAtOriginalFrame, clampKeyframe, type LayoutKeyframe } from '../../core/layoutKeyframes';
import type { EditState } from './editState';

type Kept = { id: number; originalStart: number; playbackStart: number; playbackEnd: number };

/** 現在の実効レイアウト（大域KFがあれば sample・無ければ base）を原本フレームで得る。 */
function effectiveSampleAtOriginal(state: EditState, originalFrame: number): LayoutKeyframe {
  const base = state.mainLayout ?? DEFAULT_MAIN_LAYOUT;
  if (state.layoutKeyframes.length >= 2) {
    const s = sampleAtOriginalFrame(state.layoutKeyframes, originalFrame);
    return { originalFrame, x: s.x, y: s.y, scale: s.scale, rotation: s.rotation };
  }
  return { originalFrame, x: base.position.x, y: base.position.y, scale: base.scale, rotation: base.rotation ?? 0 };
}

function withSorted(list: LayoutKeyframe[]): LayoutKeyframe[] {
  return [...list].sort((a, b) => a.originalFrame - b.originalFrame);
}

/** 原本フレームにキーフレームを追加/置換（同 originalFrame は置換）。昇順維持。 */
export function addKeyframeAt(state: EditState, kf: LayoutKeyframe): EditState {
  // 非有限値を含むキーフレームは打たない（既定値へ倒した偽のKFを黙って挿さないため）。
  if (![kf.originalFrame, kf.x, kf.y, kf.scale, kf.rotation].every((v) => Number.isFinite(v))) return state;
  const c = clampKeyframe(kf);
  const rest = state.layoutKeyframes.filter((k) => k.originalFrame !== c.originalFrame);
  return { ...state, layoutKeyframes: withSorted([...rest, c]) };
}

/** 再生ヘッド位置に「現在の見た目」でキーフレームを打つ（punch）。 */
export function punchKeyframe(state: EditState, playbackFrame: number, keptSegments: Kept[]): EditState {
  const originalFrame = playbackFrameToOriginal(playbackFrame, keptSegments);
  return addKeyframeAt(state, effectiveSampleAtOriginal(state, originalFrame));
}

/** index のキーフレームを削除。 */
export function removeKeyframe(state: EditState, index: number): EditState {
  if (index < 0 || index >= state.layoutKeyframes.length) return state;
  return { ...state, layoutKeyframes: state.layoutKeyframes.filter((_, i) => i !== index) };
}

/** 全キーフレーム解除。 */
export function clearKeyframes(state: EditState): EditState {
  if (state.layoutKeyframes.length === 0) return state;
  return { ...state, layoutKeyframes: [] };
}

/** index のキーフレームの 1 フィールドを更新（originalFrame 変更時は再ソート）。 */
export function setKeyframeField(
  state: EditState, index: number, field: keyof LayoutKeyframe, value: number,
): EditState {
  if (!Number.isFinite(value)) return state;
  const list = state.layoutKeyframes;
  if (index < 0 || index >= list.length) return state;
  const v =
    field === 'originalFrame' ? Math.max(0, Math.round(value))
      : field === 'x' || field === 'y' ? clampLayoutPos(value)
        // scale はKF専用レンジ [0.1, 8]（clampKeyframe と一致。プリセット zoomIn の bs*1.8 が 5 に切られないように）。
        : field === 'scale' ? Math.min(8, Math.max(0.1, value))
          : clampRotation(value);
  const next = list.map((k, i) => (i === index ? { ...k, [field]: v } : k));
  return { ...state, layoutKeyframes: field === 'originalFrame' ? withSorted(next) : next };
}

/**
 * プリセット糖衣: 再生ヘッド位置を起点に大域KFを 2 点生成する（既存の見た目を基準に相対で動かす）。
 * panLeft: base.x+0.4 → base.x-0.4 / panRight: 逆 / zoomIn: base.scale → *1.8 / zoomOut: 逆。
 * 2 点目は originalFrame + durationFrames（既定 fps*2 秒）。
 */
export function applyPresetKeyframes(
  state: EditState, preset: 'panLeft' | 'panRight' | 'zoomIn' | 'zoomOut',
  playbackFrame: number, keptSegments: Kept[], durationFrames: number,
): EditState {
  const base = state.mainLayout ?? DEFAULT_MAIN_LAYOUT;
  const of0 = playbackFrameToOriginal(playbackFrame, keptSegments);
  const of1 = of0 + Math.max(1, Math.round(durationFrames));
  const bx = base.position.x, by = base.position.y, bs = base.scale, br = base.rotation ?? 0;
  let k0: LayoutKeyframe, k1: LayoutKeyframe;
  const P = 0.4, Z = 1.8;
  if (preset === 'panLeft') { k0 = { originalFrame: of0, x: bx + P, y: by, scale: bs, rotation: br }; k1 = { originalFrame: of1, x: bx - P, y: by, scale: bs, rotation: br }; }
  else if (preset === 'panRight') { k0 = { originalFrame: of0, x: bx - P, y: by, scale: bs, rotation: br }; k1 = { originalFrame: of1, x: bx + P, y: by, scale: bs, rotation: br }; }
  else if (preset === 'zoomIn') { k0 = { originalFrame: of0, x: bx, y: by, scale: bs, rotation: br }; k1 = { originalFrame: of1, x: bx, y: by, scale: bs * Z, rotation: br }; }
  else { k0 = { originalFrame: of0, x: bx, y: by, scale: bs * Z, rotation: br }; k1 = { originalFrame: of1, x: bx, y: by, scale: bs, rotation: br }; }
  return addKeyframeAt(addKeyframeAt(state, k0), k1);
}
