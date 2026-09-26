import { addCutRegion, removeCutRegion } from '../../core/cutEngine';
import { clampSubtitleRange } from '../../core/telopEngine';
import { mergeSegments, splitSegment, splitTelopText } from '../../core/segmentOps';
import type { CutRegion, EditorTelop, WordChip } from '../../core/types';
import { normalizeMultiSelection, type EditState, type Selection } from './editState';
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
 *
 * 分割後は **右（後半）断片を選択状態にする**。ユーザーは「ここから先を書き換えたい」
 * ので分割するのが自然な流れで、左を選んだままだと「分割したのに左が編集対象」という
 * 見えない食い違いになる（実機不具合 2026-08-17: 分割後に打った文字が左へ入った）。
 * `titleOps.splitTitleAt`（タイトル分割）も同仕様に揃えてある。
 */
export function splitTelopAt(
  state: EditState,
  telopId: number,
  atFrame: number,
  leftText: string,
  rightText: string,
): EditState {
  if (!Number.isFinite(atFrame)) return state; // NaN は splitSegment を素通りして区間端が NaN になる
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
  // 選択が新断片へ移るため、複数選択集合はプライマリを含まなくなる＝正規化で解除される。
  return normalizeMultiSelection({
    ...state,
    telops,
    nextTelopId: state.nextTelopId + 1,
    selection: { kind: 'telop', id: pair[1].id },
  });
}

/**
 * テキストも時間位置に応じて左右へ分配する分割（分割ボタン/ヘッドで分割の共通入口）。
 * chips（単語チップ）があればチップ境界で、無ければ時間比で本文を分ける。
 *
 * ただし **手動（装飾）テロップ `manual:true` は本文を割らず、両断片へ丸ごと複製する**。
 * 手動テロップの本文はユーザーの自由入力で、transcript の単語列とも発話時刻とも
 * 一切対応しない。チップ境界で割ると transcript 側の文字数（leftJoined.length）が
 * そのまま本文の切り出し位置になり、時間比で割っても意味のない位置で切れる。
 * 実機不具合（2026-08-17・04_golf-short-0811）では "当たり前ですよね." が
 * 「当たり前ですよね」＋「.」へ割れ、右断片が実質空になっていた。
 * 分割は「時間を 2 つに割る」操作と定義し、本文は両方へ残して不要な側を
 * ユーザーが打ち替える（＝分割直後は右が選択済み）方が破壊的でない。
 */
export function splitTelopWithText(
  state: EditState,
  telopId: number,
  atFrame: number,
  chips: WordChip[],
): EditState {
  const telop = state.telops.find((t) => t.id === telopId);
  if (!telop) return state;
  const [leftText, rightText] =
    telop.manual === true
      ? [telop.text, telop.text]
      : splitTelopText(
          telop.text,
          telop.originalStart,
          telop.originalEnd,
          atFrame,
          // チップ列と本文が対応していなければチップを渡さない＝時間比で割る。
          // `manual:true` でない**字幕**にも transcript と無関係な本文はありうる
          // （＋追加メニューで足した「新しい字幕」など）。この場合チップ側の文字数が
          // そのまま本文の切り出し位置になり、右断片が 1 文字に潰れる。
          chipsUsableForText(chips, telop.text) ? chips : [],
        );
  return splitTelopAt(state, telopId, atFrame, leftText, rightText);
}

/**
 * 単語チップ列を本文の分割位置の手がかりに使えるか。
 *
 * 判定は**文字列の完全一致ではなく文字数の対応**。誤字修正（typo_dict・手直し）で
 * 「効き目→利き目」のように直った本文は文字列が一致しないが、文字数が同じなら
 * チップ境界の文字数がそのまま本文の切り出し位置として使える（splitTelopText の
 * 近似経路）。完全一致だけを条件にすると、誤字修正済みの字幕がすべて時間比へ落ちて
 * 語の途中で切れる。
 *
 * 逆に文字数が違えば、チップの文字数を本文へ当てても意味のない位置で切れるだけなので
 * 時間比へ落とす（＋追加した「新しい字幕」のような transcript と無関係な本文）。
 * 改行はチップに存在しない表示上の要素なので除いて数える。
 */
function chipsUsableForText(chips: WordChip[], text: string): boolean {
  if (chips.length === 0) return false;
  return chips.map((c) => c.text).join('').length === text.replace(/\n/g, '').length;
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
  // 結合で 1 件消える（＋新 ID が生まれる）ので複数選択集合の整合を取り直す。
  return normalizeMultiSelection({ ...state, telops, nextTelopId: state.nextTelopId + 1, selection });
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
  // 新テロップがプライマリになるため、既存の複数選択集合は正規化で解除される。
  return normalizeMultiSelection({
    ...state,
    telops,
    nextTelopId: state.nextTelopId + 1,
    selection: { kind: 'telop', id: telop.id },
  });
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

/**
 * 手動追加した字幕として意味を持つ最小の尺（フレーム）。
 * これより短い隙間しか無い位置では字幕を足さない（潰れた 1 フレーム字幕を作らない）。
 */
export const MIN_SUBTITLE_FRAMES = 10;

/**
 * 時間軸上で `start` より前（または同時）に始まる最後の**字幕**の配列インデックス。
 * 装飾テロップ（manual:true）は字幕の並びと無関係なので飛ばす。無ければ -1。
 */
function prevSubtitleIndex(telops: EditorTelop[], start: number): number {
  let best = -1;
  for (let i = 0; i < telops.length; i++) {
    const t = telops[i];
    if (t === undefined || t.manual === true) continue;
    if (t.originalStart > start) continue;
    const cur = best === -1 ? undefined : telops[best];
    if (cur === undefined || t.originalStart > cur.originalStart) best = i;
  }
  return best;
}

/** `subtitleInsertSpan` の結果。追加できない位置では null が返る。 */
export interface SubtitleInsertSpan {
  start: number;
  end: number;
  /**
   * 要求した原本フレームより後ろへずれたか。
   * ヘッドが既存字幕の内側にあるとき「その字幕の直後の空きへ寄せて追加する」のが仕様
   * （設計書 v2・P2-3）。黙ってずらすと「押した所と違う場所に出た」と見えるため、
   * 呼び出し側はこのフラグで一時メッセージを出す。
   */
  shifted: boolean;
}

/**
 * 字幕を originalStart に足すときの実際の区間を返す。追加できなければ null。
 * `addSubtitleAtFrame` の前段そのもの（UI は追加前の可否判定・通知にこれを使う）。
 */
export function subtitleInsertSpan(
  telops: EditorTelop[],
  nextTelopId: number,
  originalStart: number,
  fps: number,
): SubtitleInsertSpan | null {
  if (!Number.isFinite(originalStart) || !Number.isFinite(fps) || fps <= 0) return null;
  const rawStart = Math.max(0, Math.round(originalStart));
  const duration = Math.max(1, Math.round(TELOP_DEFAULT_DURATION_SEC * fps));
  // 新 ID はまだリストに無い＝self が見つからず「字幕」として扱われる（manual 扱いにならない）。
  const first = clampSubtitleRange(telops, nextTelopId, rawStart, rawStart + duration);
  // ヘッドが既存字幕の内側だと開始が後ろへ寄る。寄せた地点から既定尺を取り直す
  // （取り直さないと「3 秒の字幕」が寄せたぶんだけ黙って短くなる）。
  const span =
    first.originalStart === rawStart
      ? first
      : clampSubtitleRange(telops, nextTelopId, first.originalStart, first.originalStart + duration);
  const { originalStart: start, originalEnd: end } = span;
  if (end - start < MIN_SUBTITLE_FRAMES) return null;
  return { start, end, shifted: start !== rawStart };
}

/**
 * 原本フレーム originalStart に既定尺の**字幕**（manual を付けない）を足す。
 * `addTelopAtFrame`（装飾テロップ）のミラーだが、字幕は隣接字幕と重ねられないため
 * 挙動が 3 点異なる:
 *
 * - 区間は `clampSubtitleRange` で前後の字幕へ詰める。**ヘッドが既存字幕の内側なら
 *   その字幕の直後の空きへ寄せて追加する**（設計書 v2・P2-3）。詰めた結果
 *   `MIN_SUBTITLE_FRAMES` 未満しか残らなければ **state をそのまま返す（no-op・同一参照）**。
 *   呼び出し側は同一参照かどうかで「追加できなかった」を判定できる。ずれた場合の通知は
 *   `subtitleInsertSpan().shifted` を見る。
 * - 挿入位置はリスト末尾ではなく時間順（時間軸上で直前の字幕の直後）。字幕リストの
 *   並び＝時間順という既存の前提（結合・分割・保存順）を壊さないため。
 * - template / style は時間軸上で直前の字幕から継承し、見た目を揃える。
 */
export function addSubtitleAtFrame(state: EditState, originalStart: number, fps: number): EditState {
  const span = subtitleInsertSpan(state.telops, state.nextTelopId, originalStart, fps);
  if (span === null) return state;
  const { start, end } = span;

  const prevIndex = prevSubtitleIndex(state.telops, start);
  const prev = prevIndex === -1 ? undefined : state.telops[prevIndex];
  const telop: EditorTelop = {
    id: state.nextTelopId,
    originalStart: start,
    originalEnd: end,
    text: '新しい字幕',
    ...(prev?.template !== undefined ? { template: prev.template } : {}),
    ...(prev?.style !== undefined ? { style: prev.style } : {}),
  };
  const telops = [...state.telops];
  telops.splice(prevIndex + 1, 0, telop);
  // 新字幕がプライマリになるため、既存の複数選択集合は正規化で解除される（insertTelop と同じ）。
  return normalizeMultiSelection({
    ...state,
    telops,
    nextTelopId: state.nextTelopId + 1,
    selection: { kind: 'telop', id: telop.id },
  });
}
