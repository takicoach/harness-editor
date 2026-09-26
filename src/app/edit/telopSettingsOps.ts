import type { EditorTelop, TelopPosition, TelopStyle, TelopTemplate } from '../../core/types';
import { clampSubtitleRange, clampSubtitleMove } from '../../core/telopEngine';
import { normalizeMultiSelection, type EditState } from './editState';

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

/**
 * テロップテンプレート番号を設定する（spec §9）。
 * 非有限値は無視する（telopData.ts へ `template: NaN` が書かれるとプロジェクトが壊れる）。
 */
export function setTelopTemplate(state: EditState, telopId: number, template: TelopTemplate): EditState {
  if (!Number.isFinite(template)) return state;
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
  // 配列が縮むので複数選択集合の整合を取り直す（消えた ID を残さない）。
  return normalizeMultiSelection({
    ...state,
    telops: state.telops.filter((t) => t.id !== telopId),
    selection,
  });
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
  if (!Number.isFinite(originalStart) || !Number.isFinite(originalEnd)) return state;
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
  // 非有限値は無視する（複数選択版 setTelopsPosition と同じ契約）。
  if (!Number.isFinite(x) || !Number.isFinite(y)) return state;
  return patchTelop(state, telopId, (t) => ({
    ...t,
    position: { x: clamp(x, -1, 1), y: clamp(y, -1, 0) },
  }));
}

/** テロップスケールを設定し 0.3..3.0 へクランプする（schema 契約の推奨範囲）。 */
export function setTelopScale(state: EditState, telopId: number, scale: number): EditState {
  // 非有限値は無視する（複数選択版 setTelopsScale と同じ契約）。
  if (!Number.isFinite(scale)) return state;
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

/**
 * 全テロップの位置・大きさ（position / scale）を一括設定する。
 * x は -1..1、y は -1..0（下端固定）、scale は 0.3..3.0 へクランプ（個別設定と同じ範囲）。
 */
export function setAllTelopPositions(
  state: EditState,
  position: TelopPosition,
  scale: number,
): EditState {
  if (!Number.isFinite(position.x) || !Number.isFinite(position.y) || !Number.isFinite(scale)) return state;
  const x = clamp(position.x, -1, 1);
  const y = clamp(position.y, -1, 0);
  const s = clamp(scale, 0.3, 3.0);
  // 各テロップへ独立した position オブジェクトを渡す（参照共有しない＝一回きりのコピー）。
  return { ...state, telops: state.telops.map((t) => ({ ...t, position: { x, y }, scale: s })) };
}

// ---------------------------------------------------------------------------
// 複数選択の一括 ops
//
// 共通契約:
// - `ids` は Set 化して重複を無視する。`telops` に実在しない ID は無視する。
// - 実在対象がゼロ、または結果が全て同値なら **同一 state 参照** を返す
//   （履歴へ空の Undo を積まないため）。
// - `Number.isFinite` でない入力は no-op（同一 state 参照）。
// ---------------------------------------------------------------------------

/**
 * 指定 ID 群のテロップへ patch を適用する共通ヘルパ。
 * 変更が 1 件も起きなければ（対象ゼロ・全同値）同一 state 参照を返す。
 * @param same 変更前後が同値かの判定。true なら「その 1 件は変わらなかった」とみなす。
 */
function patchTelops(
  state: EditState,
  ids: number[],
  patch: (t: EditorTelop) => EditorTelop,
  same: (before: EditorTelop, after: EditorTelop) => boolean,
): EditState {
  const targets = new Set(ids);
  if (targets.size === 0) return state;
  let changed = false;
  const telops = state.telops.map((t) => {
    if (!targets.has(t.id)) return t;
    const next = patch(t);
    if (same(t, next)) return t;
    changed = true;
    return next;
  });
  if (!changed) return state;
  return { ...state, telops };
}

/**
 * 複数テロップの位置 x/y を同じ値へ一括設定する（クランプは {@link setTelopPosition} と同一）。
 * position オブジェクトはテロップごとに独立して作る（参照共有しない）。
 */
export function setTelopsPosition(
  state: EditState,
  ids: number[],
  x: number,
  y: number,
): EditState {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return state;
  const cx = clamp(x, -1, 1);
  const cy = clamp(y, -1, 0);
  return patchTelops(
    state,
    ids,
    (t) => ({ ...t, position: { x: cx, y: cy } }),
    (before) => before.position?.x === cx && before.position?.y === cy,
  );
}

/** 複数テロップのスケールを一括設定する（0.3..3.0 へクランプ・単体版と同一）。 */
export function setTelopsScale(state: EditState, ids: number[], scale: number): EditState {
  if (!Number.isFinite(scale)) return state;
  const s = clamp(scale, 0.3, 3.0);
  return patchTelops(
    state,
    ids,
    (t) => ({ ...t, scale: s }),
    (before) => before.scale === s,
  );
}

/**
 * 複数テロップをまとめて削除する。
 *
 * **削除するのは飾りテロップ（`manual:true`）のみ。字幕はスキップする。**
 * 字幕の「削除」は既存契約どおり動画区間カット（`toggleSegmentCut`）であって配列からの
 * 物理削除ではない（{@link removeTelop} の docstring と同じ契約）。混在選択で字幕まで
 * 消すと、その契約が黙って変わってしまう。
 *
 * 削除対象が 1 件も無ければ同一 state 参照を返す。削除後は
 * {@link normalizeMultiSelection} を通して選択・複数選択集合の整合を取る。
 */
export function removeTelops(state: EditState, ids: number[]): EditState {
  const targets = new Set(ids);
  if (targets.size === 0) return state;
  const removable = new Set(
    state.telops.filter((t) => targets.has(t.id) && t.manual === true).map((t) => t.id),
  );
  if (removable.size === 0) return state;
  const telops = state.telops.filter((t) => !removable.has(t.id));
  const selection =
    state.selection?.kind === 'telop' && removable.has(state.selection.id)
      ? null
      : state.selection;
  return normalizeMultiSelection({ ...state, telops, selection });
}
