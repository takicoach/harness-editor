import { normalizeCutRegions, originalToPlayback, playbackToOriginal } from './cutEngine';
import type { CutRegion, EditorTelop, TelopSegment } from './types';

/**
 * TelopSegment[]（再生フレーム）を EditorTelop[]（原本フレームアンカー）へ変換する。
 * カット編集時はアンカーを基準に再生フレームを射影し直すため、再マップが自明に正しくなる。
 */
export function anchorTelops(telops: TelopSegment[], regions: CutRegion[]): EditorTelop[] {
  return telops.map((t) => {
    const { startFrame, endFrame, originalStart, originalEnd, ...rest } = t;
    // 両方とも有限数値として存在する場合は逆射影せず直接使う（flagged テロップの原本区間保持）。
    // 防御的チェック: telopData.ts は任意の JS を eval するため不正値が来うる。
    const hasExplicitFrames =
      typeof originalStart === 'number' && Number.isFinite(originalStart) &&
      typeof originalEnd === 'number' && Number.isFinite(originalEnd);
    if (hasExplicitFrames) {
      return {
        ...rest,
        originalStart,
        originalEnd,
      };
    }
    return {
      ...rest,
      originalStart: playbackToOriginal(startFrame, regions),
      originalEnd: playbackToOriginal(endFrame, regions),
    };
  });
}

/**
 * EditorTelop[]（原本フレームアンカー）を TelopSegment[]（再生フレーム）へ射影する。
 * アンカーがカット区間内に落ちた場合は最寄りの再生フレームへ丸める
 * （カット区間内テロップは事前に clampTelops で処理する想定）。
 */
export function projectTelops(telops: EditorTelop[], regions: CutRegion[]): TelopSegment[] {
  return telops.map((t) => {
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

export interface ClampResult {
  telops: EditorTelop[];
  /** カット区間に完全に飲まれた（範囲外になった）テロップの ID。 */
  flaggedIds: number[];
}

/**
 * カット区間と重なるテロップの端を区間外へ寄せる。
 * 完全に飲まれたテロップは flaggedIds へ入れ、テロップ自体は残す（spec 12 章）。
 */
export function clampTelops(telops: EditorTelop[], regions: CutRegion[]): ClampResult {
  const cuts = normalizeCutRegions(regions);
  const flaggedIds: number[] = [];
  const result = telops.map((t) => {
    let start = t.originalStart;
    let end = t.originalEnd;
    for (const c of cuts) {
      // 開始端がカット内 → カット終端へ
      if (start >= c.start && start < c.end) start = c.end;
      // 終了端がカット内 → カット始端へ
      if (end > c.start && end <= c.end) end = c.start;
    }
    if (start >= end) {
      flaggedIds.push(t.id);
      return t; // 飲まれたテロップはそのまま残す
    }
    if (start === t.originalStart && end === t.originalEnd) return t;
    return { ...t, originalStart: start, originalEnd: end };
  });
  return { telops: result, flaggedIds };
}

/**
 * 字幕（manual でないテロップ）の表示区間を、隣接する他の字幕と重ならないようクランプする。
 * 装飾テロップ（manual:true）は対象外＝クランプせずそのまま返す
 * （手動追加テロップは字幕と独立に自由配置・重なり許容のため）。
 * 直前の字幕の originalEnd／直後の字幕の originalStart のみを境界とし、
 * 装飾テロップとの重なりは無視する（隣接「字幕」同士の重なりのみ解消する）。
 */
export function clampSubtitleRange(
  telops: EditorTelop[],
  telopId: number,
  originalStart: number,
  originalEnd: number,
): { originalStart: number; originalEnd: number } {
  const self = telops.find((t) => t.id === telopId);
  if (self?.manual) return { originalStart, originalEnd };

  const subtitles = telops.filter((t) => t.id !== telopId && !t.manual);

  const prev = subtitles.reduce<EditorTelop | null>((best, t) => {
    if (t.originalStart >= originalStart) return best;
    if (!best || t.originalStart > best.originalStart) return t;
    return best;
  }, null);
  const next = subtitles.reduce<EditorTelop | null>((best, t) => {
    if (t.originalStart < originalStart) return best;
    if (!best || t.originalStart < best.originalStart) return t;
    return best;
  }, null);

  let start = originalStart;
  let end = originalEnd;
  if (prev && start < prev.originalEnd) start = prev.originalEnd;
  if (next && end > next.originalStart) end = next.originalStart;
  if (start >= end) end = start + 1;

  return { originalStart: start, originalEnd: end };
}

/**
 * 字幕の平行移動（本体ドラッグ）用クランプ。区間長を保ったまま、
 * 直前の字幕の originalEnd／直後の字幕の originalStart を境界として移動を止める。
 * 端を切り詰める clampSubtitleRange と違い、尺は変えない（隙間が尺より狭い場合のみ
 * 隙間いっぱいに収める）。装飾テロップ（manual:true）は制限なし。
 * 収まる場所がない場合は null を返す（呼び出し側は移動を無視する）。
 */
export function clampSubtitleMove(
  telops: EditorTelop[],
  telopId: number,
  desiredStart: number,
  duration: number,
): { originalStart: number; originalEnd: number } | null {
  const self = telops.find((t) => t.id === telopId);
  if (self?.manual) return { originalStart: desiredStart, originalEnd: desiredStart + duration };

  const subtitles = telops.filter((t) => t.id !== telopId && !t.manual);
  const prev = subtitles.reduce<EditorTelop | null>((best, t) => {
    if (t.originalStart >= desiredStart) return best;
    if (!best || t.originalStart > best.originalStart) return t;
    return best;
  }, null);
  const next = subtitles.reduce<EditorTelop | null>((best, t) => {
    if (t.originalStart < desiredStart) return best;
    if (!best || t.originalStart < best.originalStart) return t;
    return best;
  }, null);

  const lower = prev ? prev.originalEnd : 0;
  const upper = next ? next.originalStart : Number.POSITIVE_INFINITY;
  // 尺を保てる範囲 [lower, upper - duration] へ start をクランプする。
  const start = Math.min(Math.max(desiredStart, lower), Math.max(lower, upper - duration));
  const end = Math.min(start + duration, upper);
  if (end <= start) return null;
  return { originalStart: start, originalEnd: end };
}
