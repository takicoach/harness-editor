import { addCutRegion, removeCutRegion } from '../../core/cutEngine';
import { mergeSegments, splitSegment, splitTelopText } from '../../core/segmentOps';
import type { CutRegion, EditorTelop, WordChip } from '../../core/types';
import type { EditState, Selection } from './editState';
import { chipCutState } from './wordCutState';

/**
 * 単語チップの削除/復帰をトグルする（spec §7-8: 単語削除 = その単語区間をカット）。
 * 未カットなら chip 区間を cutRegions へ追加、カット済みなら除去する。
 */
export function toggleWordCut(state: EditState, chip: WordChip): EditState {
  const region: CutRegion = { start: chip.originalStart, end: chip.originalEnd };
  const cutRegions = chipCutState(chip, state.cutRegions)
    ? removeCutRegion(state.cutRegions, region)
    : addCutRegion(state.cutRegions, region);
  return { ...state, cutRegions };
}

/** 区間 [start,end] がカット済み（いずれかのカット区間へ完全包含）かを判定する。 */
function regionIsCut(region: CutRegion, regions: CutRegion[]): boolean {
  for (const r of regions) {
    if (region.start >= r.start && region.end <= r.end) return true;
  }
  return false;
}

/**
 * セグメント行の削除/復帰をトグルする（spec §7-8: 行削除 = セグメント区間まるごとをカット）。
 * テロップ自体はリストへ残す（spec §8「削除した行はリストに残り再クリックで復帰」）。
 */
export function toggleSegmentCut(state: EditState, telopId: number): EditState {
  const telop = state.telops.find((t) => t.id === telopId);
  if (!telop) return state;
  const region: CutRegion = { start: telop.originalStart, end: telop.originalEnd };
  const cutRegions = regionIsCut(region, state.cutRegions)
    ? removeCutRegion(state.cutRegions, region)
    : addCutRegion(state.cutRegions, region);
  return { ...state, cutRegions };
}

/**
 * セグメントを atFrame（原本フレーム）で 2 つに分割する。
 * 後半セグメントには nextTelopId を採番し、元の位置の直後へ挿入する。
 * 分割位置が区間端でコアが throw する場合は何もせず state を返す。
 */
export function splitTelopAt(
  state: EditState,
  telopId: number,
  atFrame: number,
  leftText: string,
  rightText: string,
): EditState {
  const index = state.telops.findIndex((t) => t.id === telopId);
  if (index === -1) return state;
  const telop = state.telops[index];
  if (telop === undefined) return state;
  let pair;
  try {
    pair = splitSegment(telop, atFrame, leftText, rightText, state.nextTelopId);
  } catch {
    return state; // 分割位置が区間外（端ぴったり等）
  }
  const telops = [...state.telops];
  telops.splice(index, 1, pair[0], pair[1]);
  return { ...state, telops, nextTelopId: state.nextTelopId + 1 };
}

/**
 * テキストも時間位置に応じて左右へ分配する分割（分割ボタン/ヘッドで分割の共通入口）。
 * chips（単語チップ）があればチップ境界で、無ければ時間比で本文を分ける。
 */
export function splitTelopWithText(
  state: EditState,
  telopId: number,
  atFrame: number,
  chips: WordChip[],
): EditState {
  const telop = state.telops.find((t) => t.id === telopId);
  if (!telop) return state;
  const [leftText, rightText] = splitTelopText(
    telop.text,
    telop.originalStart,
    telop.originalEnd,
    atFrame,
    chips,
  );
  return splitTelopAt(state, telopId, atFrame, leftText, rightText);
}

/**
 * 既存のカット区間 target の片端（start / end）を newFrame へ動かす。
 * コアの removeCutRegion（古い区間を抜く）＋ addCutRegion（端を動かした区間を入れる）
 * の合成で実現する。コアには新規関数を足さない（Plan 2B-2 設計判断 2）。
 *
 * - newFrame は 0 以上へクランプし、小数は丸める。
 * - 端を動かした結果 start >= end になったら（区間が潰れたら）その区間は除去する。
 * - target が現在の cutRegions に存在しなければ state をそのまま返す。
 * - newFrame が有限数値でなければ state をそのまま返す（clampZoom の Number.isFinite ガードと対称）。
 */
export function resizeCutRegion(
  state: EditState,
  target: CutRegion,
  edge: 'start' | 'end',
  newFrame: number,
): EditState {
  if (!Number.isFinite(newFrame)) return state;

  // target が（正規化後の）現在のカット区間に一致するか確認する。
  const exists = state.cutRegions.some(
    (r) => r.start === target.start && r.end === target.end,
  );
  if (!exists) return state;

  const frame = Math.max(0, Math.round(newFrame));
  const nextStart = edge === 'start' ? frame : target.start;
  const nextEnd = edge === 'end' ? frame : target.end;

  // まず古い区間を抜く。
  const withoutTarget = removeCutRegion(state.cutRegions, target);

  // 潰れた（端が反対端を越えた／一致した）区間は追加しない＝そのまま除去。
  if (nextStart >= nextEnd) {
    return { ...state, cutRegions: withoutTarget };
  }
  const cutRegions = addCutRegion(withoutTarget, { start: nextStart, end: nextEnd });
  return { ...state, cutRegions };
}

/**
 * 指定セグメントを「リスト上の次のセグメント」と結合する。
 * 結合後セグメントには nextTelopId を採番する。次が無ければ何もしない。
 */
export function mergeTelopWithNext(state: EditState, telopId: number): EditState {
  const index = state.telops.findIndex((t) => t.id === telopId);
  if (index === -1) return state;
  const first = state.telops[index];
  if (first === undefined) return state;
  // 「次のセグメント」は飾り（manual:true）を飛ばして次の字幕を探す。
  let secondIndex = -1;
  for (let i = index + 1; i < state.telops.length; i++) {
    if (state.telops[i]?.manual !== true) {
      secondIndex = i;
      break;
    }
  }
  const second = secondIndex === -1 ? undefined : state.telops[secondIndex];
  if (second === undefined) return state;
  const merged = mergeSegments(first, second, state.nextTelopId);
  // second（後方）を除去してから first 位置を merged に置換（index < secondIndex なので index は不変）。
  const telops = state.telops.filter((_, i) => i !== secondIndex);
  telops[index] = merged;
  const mergedId = state.nextTelopId;
  const wasSelected =
    state.selection?.kind === 'telop' &&
    (state.selection.id === first.id || state.selection.id === second.id);
  const selection: Selection | null = wasSelected
    ? { kind: 'telop', id: mergedId }
    : state.selection;
  return { ...state, telops, nextTelopId: state.nextTelopId + 1, selection };
}

/**
 * 「テロップを追加」ボタンの挿入区間を計算する純関数。
 * - アンカー（selectedTelopId のテロップ）があればその直後から、無ければ末尾テロップの終端から開始する。
 * - 既定 2 秒（2*fps フレーム）の長さ。動画末尾 durationFrames を超えないよう end をクランプし、
 *   末尾近くで 2 秒に満たない場合はその場で詰める（start は常にアンカー終端のまま＝重複しない）。
 * - 挿入余地が無い（start>=end）場合は null を返す（呼び出し側はボタンを無効化する）。
 */
export function computeInsertSpan(
  telops: EditorTelop[],
  selectedTelopId: number | null,
  fps: number,
  durationFrames: number,
): { start: number; end: number } | null {
  const anchor = selectedTelopId === null
    ? undefined
    : telops.find((t) => t.id === selectedTelopId);
  const lastEnd = telops.reduce((m, t) => Math.max(m, t.originalEnd), 0);
  const rawStart = anchor ? anchor.originalEnd : lastEnd;
  // 開始は動画範囲内へクランプ（アンカー終端が動画長を超えていても破綻させない）。
  const start = Math.max(0, Math.min(rawStart, durationFrames));
  const dur = Math.max(1, Math.round(2 * fps));
  const end = Math.min(durationFrames, start + dur);
  if (start >= end) return null;
  return { start, end };
}

/**
 * 範囲 [start, end) をカット区間として追加する（タイムライン範囲選択カット）。
 * - start/end は 0 以上へクランプし丸める。丸めた結果も含め start>=end になる区間は state をそのまま返す。
 * - 非有限値も state をそのまま返す。既存カットと重なれば addCutRegion 側でマージされる。
 */
export function cutRange(state: EditState, start: number, end: number): EditState {
  if (!Number.isFinite(start) || !Number.isFinite(end)) return state;
  const s = Math.max(0, Math.round(start));
  const e = Math.max(0, Math.round(end));
  if (s >= e) return state;
  return { ...state, cutRegions: addCutRegion(state.cutRegions, { start: s, end: e }) };
}

/** 範囲 [start, end) がいずれかのカット区間と 1 フレームでも重なるか（「カットを開ける」の有効判定）。 */
export function rangeOverlapsCut(regions: CutRegion[], start: number, end: number): boolean {
  return regions.some((r) => start < r.end && end > r.start);
}

/**
 * 範囲 [start, end) をカット区間から差し引く＝カットを開けて素材を復活させる。
 * 範囲がカット区間の内側なら区間は 2 つに割れる。カットと重ならない・不正な範囲は state をそのまま返す。
 */
export function openCutRange(state: EditState, start: number, end: number): EditState {
  if (!Number.isFinite(start) || !Number.isFinite(end)) return state;
  const s = Math.max(0, Math.round(start));
  const e = Math.max(0, Math.round(end));
  if (s >= e) return state;
  if (!rangeOverlapsCut(state.cutRegions, s, e)) return state;
  return { ...state, cutRegions: removeCutRegion(state.cutRegions, { start: s, end: e }) };
}

/** カット統合ボタンの文脈。'open'＝選択が完全にカット済み区間の内側（カットを開ける）。 */
export type CutButtonMode = 'cut' | 'open';

/**
 * カット統合ボタンのラベル・動作判定（純関数）。
 * - 選択 [start, end) がいずれか 1 つのカット区間に完全内包 → 'open'
 * - それ以外（未カットのみ / またぎ / 不正範囲）→ 'cut'（またぎはカットを広げる意図と解釈）
 */
export function cutButtonMode(regions: CutRegion[], start: number, end: number): CutButtonMode {
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'cut';
  const s = Math.max(0, Math.round(start));
  const e = Math.max(0, Math.round(end));
  if (s >= e) return 'cut';
  return regions.some((r) => s >= r.start && e <= r.end) ? 'open' : 'cut';
}

/**
 * 新しいテロップを originalStart〜originalEnd で挿入する（spec §9 テロップ追加）。
 * afterTelopId の直後（リスト順）へ挿入し、null または不在 ID なら末尾へ。
 * nextTelopId を採番して新テロップへ割り当て、新テロップを選択状態にする。
 * 区間は 0 以上へクランプ・丸めし、start>=end の不正区間は無視して state を返す。
 */
export function insertTelop(
  state: EditState,
  afterTelopId: number | null,
  originalStart: number,
  originalEnd: number,
): EditState {
  if (!Number.isFinite(originalStart) || !Number.isFinite(originalEnd)) return state;
  const start = Math.max(0, Math.round(originalStart));
  const end = Math.max(0, Math.round(originalEnd));
  if (start >= end) return state;
  const found = afterTelopId === null ? -1 : state.telops.findIndex((t) => t.id === afterTelopId);
  const index = found === -1 ? state.telops.length : found + 1;
  // 挿入位置の直前テロップから template を継承し、全体の見た目を保つ。
  const inheritedTemplate = index > 0 ? state.telops[index - 1]?.template : undefined;
  const telop: EditorTelop = {
    id: state.nextTelopId,
    originalStart: start,
    originalEnd: end,
    text: '新しいテロップ',
    manual: true,
    ...(inheritedTemplate !== undefined ? { template: inheritedTemplate } : {}),
  };
  const telops = [...state.telops];
  telops.splice(index, 0, telop);
  return {
    ...state,
    telops,
    nextTelopId: state.nextTelopId + 1,
    selection: { kind: 'telop', id: telop.id },
  };
}

/** ＋テロップの既定尺（秒）。タイトル(5s)と区別し字幕想定で短め。 */
export const TELOP_DEFAULT_DURATION_SEC = 3;

/** 原本フレーム originalStart に既定尺の装飾テロップを足す（末尾 append・選択）。addImage ミラー。 */
export function addTelopAtFrame(state: EditState, originalStart: number, fps: number): EditState {
  if (!Number.isFinite(originalStart) || !Number.isFinite(fps) || fps <= 0) return state;
  const start = Math.max(0, Math.round(originalStart));
  const end = start + Math.max(1, Math.round(TELOP_DEFAULT_DURATION_SEC * fps));
  return insertTelop(state, null, start, end);
}
