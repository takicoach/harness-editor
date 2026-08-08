import type { EditorTelop, TelopPosition, TelopStyle, TelopTemplate } from '../../core/types';
import { clampSubtitleRange, clampSubtitleMove } from '../../core/telopEngine';
import type { EditState } from './editState';

/** 指定 ID のテロップへ patch を適用するヘルパ（不在 ID はそのまま）。 */
function patchTelop(
  state: EditState,
  telopId: number,
  patch: (t: EditorTelop) => EditorTelop,
): EditState {
  return {
    ...state,
    telops: state.telops.map((t) => (t.id === telopId ? patch(t) : t)),
  };
}

/** 数値を [min,max] へクランプする。 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** テロップテンプレート番号を設定する（spec §9）。 */
export function setTelopTemplate(state: EditState, telopId: number, template: TelopTemplate): EditState {
  return patchTelop(state, telopId, (t) => ({ ...t, template }));
}

/** テロップスタイルを設定する（spec §9）。 */
export function setTelopStyle(state: EditState, telopId: number, style: TelopStyle): EditState {
  return patchTelop(state, telopId, (t) => ({ ...t, style }));
}

/**
 * ハイライト語を設定する（spec §9）。
 * 空文字は「ハイライト無し」とみなし highlight プロパティ自体を取り除く
 * （telopData.ts のシリアライザは undefined を出力しないため）。
 */
export function setTelopHighlight(state: EditState, telopId: number, highlight: string): EditState {
  return patchTelop(state, telopId, (t) => {
    if (highlight === '') {
      const { highlight: _omit, ...rest } = t;
      return rest;
    }
    return { ...t, highlight };
  });
}

/**
 * テロップを「手動追加（装飾）」扱いにするか設定する。
 * true で manual:true を付与。false のときは manual フィールド自体を取り除く
 * （字幕へ戻す＝telopData.ts に出力しない。setTelopHighlight と同方針）。
 */
export function setTelopManual(state: EditState, telopId: number, manual: boolean): EditState {
  // 不在 ID は何も変えず同一参照を返す（呼び出し側の no-op 判定を壊さない）。
  if (!state.telops.some((t) => t.id === telopId)) return state;
  return patchTelop(state, telopId, (t) => {
    if (!manual) {
      const { manual: _omit, ...rest } = t;
      return rest;
    }
    return { ...t, manual: true };
  });
}

/**
 * 指定 ID のテロップを配列から取り除く（removeSe / removeImage と同型）。
 * 不在 ID なら state をそのまま返す。削除したテロップが選択中なら選択を外す。
 * 飾りテロップ（manual）の削除に使う。字幕の「削除」は動画区間カット（toggleSegmentCut）で別物。
 */
export function removeTelop(state: EditState, telopId: number): EditState {
  if (!state.telops.some((t) => t.id === telopId)) return state;
  const selection =
    state.selection?.kind === 'telop' && state.selection.id === telopId
      ? null
      : state.selection;
  return { ...state, telops: state.telops.filter((t) => t.id !== telopId), selection };
}

/**
 * 表示タイミング（原本フレームの開始・終了）を設定する（spec §9「表示タイミングを数値入力」）。
 * start >= end の不正入力は無視。負値は 0 へクランプする。
 */
export function setTelopTiming(
  state: EditState,
  telopId: number,
  originalStart: number,
  originalEnd: number,
): EditState {
  const start0 = Math.max(0, Math.round(originalStart));
  const end0 = Math.max(0, Math.round(originalEnd));
  if (start0 >= end0) return state;
  const { originalStart: start, originalEnd: end } = clampSubtitleRange(
    state.telops,
    telopId,
    start0,
    end0,
  );
  if (start >= end) return state;
  return patchTelop(state, telopId, (t) => ({ ...t, originalStart: start, originalEnd: end }));
}

/**
 * クリップ全体を平行移動（区間長を保って originalStart を変える）。本体ドラッグ用。
 * 字幕（manual でないテロップ）は隣接字幕と重ならないようクランプする（装飾テロップは対象外）。
 */
export function moveTelop(state: EditState, telopId: number, originalStart: number): EditState {
  if (!Number.isFinite(originalStart)) return state;
  const target = state.telops.find((t) => t.id === telopId);
  if (!target) return state;
  const newStart = Math.max(0, Math.round(originalStart));
  const duration = target.originalEnd - target.originalStart;
  const clamped = clampSubtitleMove(state.telops, telopId, newStart, duration);
  if (!clamped) return state;
  const { originalStart: start, originalEnd: end } = clamped;
  return patchTelop(state, telopId, (t) => ({ ...t, originalStart: start, originalEnd: end }));
}

/**
 * テロップ位置 x/y を設定する（spec §9 数値・プリセット経路）。
 * x は -1..1。y はテロップが下端固定のため -1..0（下端＝0／上方向＝負・下方向＝画面外なので不可）。
 */
export function setTelopPosition(
  state: EditState,
  telopId: number,
  x: number,
  y: number,
): EditState {
  return patchTelop(state, telopId, (t) => ({
    ...t,
    position: { x: clamp(x, -1, 1), y: clamp(y, -1, 0) },
  }));
}

/** テロップスケールを設定し 0.3..3.0 へクランプする（schema 契約の推奨範囲）。 */
export function setTelopScale(state: EditState, telopId: number, scale: number): EditState {
  return patchTelop(state, telopId, (t) => ({ ...t, scale: clamp(scale, 0.3, 3.0) }));
}

/** テロップの 2点アニメを設定する（undefined で解除）。不在 ID はそのまま。 */
export function setTelopMotion(
  state: EditState,
  telopId: number,
  motion: import('../../core/motion').Motion | undefined,
): EditState {
  return patchTelop(state, telopId, (t) => {
    const next = { ...t };
    if (motion === undefined) delete next.motion;
    else next.motion = motion;
    return next;
  });
}

/** 全テロップのテンプレート番号を一括設定する（全体既定の適用）。 */
export function setAllTelopTemplates(state: EditState, template: TelopTemplate): EditState {
  return { ...state, telops: state.telops.map((t) => ({ ...t, template })) };
}

/** テロップスタイルの適用範囲（スタイルを選ぶ前に決める）。 */
export type TelopStyleScope = 'one' | 'all';

/**
 * スタイル選択の適用範囲を1か所に閉じる。
 * 「選んでから別ボタンで全体適用」だと押し忘れに気づけないため、
 * UI 側は範囲トグルを先に持ち、選択そのものをここへ流す。
 */
export function applyTelopTemplateForScope(
  state: EditState,
  telopId: number,
  template: TelopTemplate,
  scope: TelopStyleScope,
): EditState {
  return scope === 'all'
    ? setAllTelopTemplates(state, template)
    : setTelopTemplate(state, telopId, template);
}

/**
 * 全テロップの位置・大きさ（position / scale）を一括設定する。
 * x は -1..1、y は -1..0（下端固定）、scale は 0.3..3.0 へクランプ（個別設定と同じ範囲）。
 */
export function setAllTelopPositions(
  state: EditState,
  position: TelopPosition,
  scale: number,
): EditState {
  const x = clamp(position.x, -1, 1);
  const y = clamp(position.y, -1, 0);
  const s = clamp(scale, 0.3, 3.0);
  // 各テロップへ独立した position オブジェクトを渡す（参照共有しない＝一回きりのコピー）。
  return { ...state, telops: state.telops.map((t) => ({ ...t, position: { x, y }, scale: s })) };
}
