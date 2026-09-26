import { normalizeCutRegions, originalToPlayback, playbackToOriginal } from './cutEngine';
import type { CutRegion, EditorVideoInsert, VideoInsert } from './types';

/**
 * VideoInsert[]（再生フレーム区間）を EditorVideoInsert[]（原本フレームアンカー）へ変換する。
 * 区間 [startFrame, endFrame) の両端を逆射影する。imageEngine.anchorImages と同型。
 * sourceInFrame / position / scale はサブ動画側の値なので ...rest で carry-through する。
 */
export function anchorVideoInserts(items: VideoInsert[], regions: CutRegion[]): EditorVideoInsert[] {
  return items.map((s) => {
    const { startFrame, endFrame, ...rest } = s;
    return {
      ...rest,
      originalStart: playbackToOriginal(startFrame, regions),
      originalEnd: playbackToOriginal(endFrame, regions),
    };
  });
}

/**
 * EditorVideoInsert[]（原本フレームアンカー）を VideoInsert[]（再生フレーム）へ射影する。
 * アンカーがカット区間内に落ちた場合は最寄りの再生フレームへ丸める
 * （カット内クリップは事前に clampVideoInserts で寄せる想定）。imageEngine.projectImages と同型。
 */
export function projectVideoInserts(items: EditorVideoInsert[], regions: CutRegion[]): VideoInsert[] {
  return items.map((t) => {
    const { originalStart, originalEnd, ...rest } = t;
    const start = originalToPlayback(originalStart, regions);
    const end = originalToPlayback(originalEnd, regions);
    return {
      ...rest,
      startFrame: Math.max(0, start ?? originalToPlayback(originalStart - 1, regions) ?? 0),
      endFrame: Math.max(0, end ?? originalToPlayback(originalEnd - 1, regions) ?? 0),
    };
  });
}

export interface VideoInsertClampResult {
  videoInserts: EditorVideoInsert[];
  /** カット区間に完全に飲まれた（範囲外になった）クリップの ID。 */
  flaggedIds: number[];
}

/**
 * カット区間と重なるクリップの端を区間外へ寄せる。
 * 完全に飲まれたクリップは flaggedIds へ入れ、クリップ自体は原形のまま残す
 * （VideoInsert スキーマには originalStart 退避が無いため、保存時は projectVideoInserts で
 *  最寄り再生フレームへ寄せて出力する。UI ではタイムラインで flagged 表示・Inspector で警告）。
 * imageEngine.clampImages と同型。
 */
export function clampVideoInserts(
  items: EditorVideoInsert[],
  regions: CutRegion[],
): VideoInsertClampResult {
  const cuts = normalizeCutRegions(regions);
  const flaggedIds: number[] = [];
  const result = items.map((t) => {
    let start = t.originalStart;
    let end = t.originalEnd;
    for (const c of cuts) {
      if (start >= c.start && start < c.end) start = c.end;
      if (end > c.start && end <= c.end) end = c.start;
    }
    if (start >= end) {
      flaggedIds.push(t.id);
      return t;
    }
    if (start === t.originalStart && end === t.originalEnd) return t;
    return { ...t, originalStart: start, originalEnd: end };
  });
  return { videoInserts: result, flaggedIds };
}

/** 原本フレーム区間の両端がカット区間内に落ちているか（UI の warning 表示用）。 */
export function videoInsertInCutRegion(
  originalStart: number,
  originalEnd: number,
  regions: CutRegion[],
): boolean {
  const startIn = originalToPlayback(originalStart, regions) === null;
  const endIn = originalToPlayback(Math.max(originalStart, originalEnd - 1), regions) === null;
  return startIn && endIn;
}

/**
 * サブ動画クリップが消費するソースフレーム数。表示長（originalEnd-originalStart）× 再生速度。
 * InsertVideo.tsx のコメント通り、消費ソース量は「尺 × rate」で決まる（endAt を明示しない設計）。
 */
export function consumedSourceFrames(v: Pick<EditorVideoInsert, 'originalStart' | 'originalEnd' | 'playbackRate' | 'timelinePlacement'>): number {
  const rate = v.playbackRate ?? 1;
  const duration = v.timelinePlacement ? v.timelinePlacement.endFrame - v.timelinePlacement.startFrame : v.originalEnd - v.originalStart;
  return Math.round(duration * rate);
}

/**
 * sourceInFrame + 消費ソースフレーム数 が sourceLengthFrames を超える量（フレーム）。
 * 超えていなければ 0。sourceLengthFrames が null（長さ不明。無音・映像のみでデコード不能、
 * または未計測）なら判定不能として null を返す（Inspector 警告の表示要否に使う）。
 */
export function videoInsertSourceOverflowFrames(
  v: Pick<EditorVideoInsert, 'originalStart' | 'originalEnd' | 'playbackRate' | 'sourceInFrame' | 'timelinePlacement'>,
  sourceLengthFrames: number | null,
): number | null {
  if (sourceLengthFrames === null) return null;
  const end = v.sourceInFrame + consumedSourceFrames(v);
  return Math.max(0, end - sourceLengthFrames);
}

/**
 * サブ動画 1 件を、既知のソース長（フレーム）内に収まるようクランプする（R-1）。
 * sourceInFrame + 消費ソースフレーム数 が sourceLengthFrames を超える場合、originalEnd を
 * 縮めて収める（sourceInFrame・originalStart は動かさない＝非破壊・イン点を保持したまま
 * 末尾だけ詰める）。変更が無ければ同一参照 v をそのまま返す。
 *
 * sourceLengthFrames が null（長さ不明）なら何もしない。長さが分からないのに削るのは
 * 「動くはずの区間を誤って壊す」リスクの方が「まれに範囲外 endAt で render が失敗する」
 * リスクより実害が大きい（頻度・巻き戻し容易性の非対称）ため、安全側 = 無変更に倒す
 * （useWaveformSamples が「波形なしでもグレースフルに継続」する既存方針と同型）。
 *
 * C-1（Codex 指摘）: 残ソースフレーム数 maxDSource を playbackRate で割って新しい
 * タイムライン長を出す時、Math.round は切り上げ側に転びうる
 * （例: maxDSource=101, rate=2 → round(50.5)=51 → 消費 round(51*2)=102 > 101。
 *   「クランプしたのに範囲外のまま」になっていた）。floor に変えて、
 * newDuration*rate が maxDSource を超えないことを整数演算で保証する。
 *
 * また、sourceInFrame が既にソース末尾以降（maxDSource<=0）、または rate が大きく
 * 1タイムラインフレーム分の消費すら maxDSource に収まらない（floor 後 0）場合は
 * 「再生可能なフレームが残っていない」ケース。旧実装はここで maxDSource を
 * Math.max(1, …) で底上げして 1 フレームを捏造していたが、その1フレームは
 * 実在しないソース位置を指すため endAt が超過したままだった（問題2）。
 * この関数はクランプで直せる範囲を超えているとみなし、データは変更せず v をそのまま
 * 返す（非破壊）。呼び出し側の clampVideoInsertsToSourceLength が unplayableIds に
 * 積んで明示的に扱う（削除・警告表示は呼び出し側の責務）。
 */
export function clampVideoInsertSourceEnd(
  v: EditorVideoInsert,
  sourceLengthFrames: number | null,
): EditorVideoInsert {
  if (sourceLengthFrames === null || !Number.isFinite(sourceLengthFrames) || sourceLengthFrames <= 0) return v;
  const overflow = videoInsertSourceOverflowFrames(v, sourceLengthFrames);
  if (overflow === null || overflow <= 0) return v;
  const rate = v.playbackRate ?? 1;
  const maxDSource = sourceLengthFrames - v.sourceInFrame;
  if (maxDSource <= 0) return v; // 再生可能フレームがゼロ（sourceInFrame がソース末尾以降）
  const newDuration = Math.floor(maxDSource / rate);
  if (newDuration <= 0) return v; // 1タイムラインフレーム分の消費すら残ソースに収まらない
  if (v.timelinePlacement) {
    const endFrame = v.timelinePlacement.startFrame + newDuration;
    return endFrame === v.timelinePlacement.endFrame ? v : { ...v, timelinePlacement: { ...v.timelinePlacement, endFrame } };
  }
  const newEnd = v.originalStart + newDuration;
  if (newEnd === v.originalEnd) return v;
  return { ...v, originalEnd: newEnd };
}

/**
 * 「クランプでは直せない＝再生できるソースフレームが1枚も残っていない」クリップか。
 * （イン点がソース終端以降、または再生速度が高すぎて1タイムラインフレーム分の消費すら
 * 残ソースに収まらない。clampVideoInsertSourceEnd が無変更で返す＝直せないケース。）
 *
 * X-2(a): 保存時（clampVideoInsertsToSourceLength の unplayableIds）と Inspector の警告文言が
 * 同じ基準で判定するための共有述語。基準がずれると「保存時に自動調整されます」と案内した
 * クリップが実は調整不能、という嘘の案内になる。
 * 長さ不明（null）は判定不能として false（安全側・警告を出さない）。
 */
export function videoInsertHasNoPlayableFrames(
  v: EditorVideoInsert,
  sourceLengthFrames: number | null,
): boolean {
  if (sourceLengthFrames === null) return false;
  const overflow = videoInsertSourceOverflowFrames(v, sourceLengthFrames);
  if (overflow === null || overflow <= 0) return false;
  return clampVideoInsertSourceEnd(v, sourceLengthFrames) === v;
}

/**
 * サブ動画配列を、file ごとの既知ソース長（フレーム）マップでクランプする（保存時に使用）。
 * マップに無い file（=長さ不明）はそのまま通す。変更されたクリップの id を clampedIds へ集める。
 *
 * C-1: clampVideoInsertSourceEnd が「再生可能フレームなし」で無変更のまま返してきたクリップは、
 * 超過が残ったままなので unplayableIds へ積む（clampedIds には入れない＝実際には直せていない
 * ため区別する）。呼び出し側で警告表示・削除提案などに使う想定。
 */
export function clampVideoInsertsToSourceLength(
  items: EditorVideoInsert[],
  sourceLengthFramesByFile: Readonly<Record<string, number>>,
): { videoInserts: EditorVideoInsert[]; clampedIds: number[]; unplayableIds: number[] } {
  const clampedIds: number[] = [];
  const unplayableIds: number[] = [];
  const videoInserts = items.map((v) => {
    const len = sourceLengthFramesByFile[v.file];
    if (len === undefined) return v;
    const next = clampVideoInsertSourceEnd(v, len);
    if (next !== v) {
      clampedIds.push(v.id);
      return next;
    }
    if (videoInsertHasNoPlayableFrames(v, len)) unplayableIds.push(v.id);
    return v;
  });
  return { videoInserts, clampedIds, unplayableIds };
}
