import { normalizeCutRegions, originalToPlayback, playbackToOriginal } from './cutEngine';
import type { CutRegion, EditorImage, ImageSegment } from './types';

/**
 * ImageSegment[]（再生フレーム区間）を EditorImage[]（原本フレームアンカー）へ変換する。
 * 区間 [startFrame, endFrame) の両端を逆射影する。telopEngine の anchorTelops と同じ要領だが、
 * 画像は flagged 原本退避フィールドを持たない（ImageSegment スキーマに無い）。
 */
export function anchorImages(images: ImageSegment[], regions: CutRegion[]): EditorImage[] {
  return images.map((s) => {
    const { startFrame, endFrame, ...rest } = s;
    return {
      ...rest,
      originalStart: playbackToOriginal(startFrame, regions),
      originalEnd: playbackToOriginal(endFrame, regions),
    };
  });
}

/**
 * EditorImage[]（原本フレームアンカー）を ImageSegment[]（再生フレーム）へ射影する。
 * アンカーがカット区間内に落ちた場合は最寄りの再生フレームへ丸める
 * （カット内画像は事前に clampImages で寄せる想定）。
 */
export function projectImages(images: EditorImage[], regions: CutRegion[]): ImageSegment[] {
  return images.map((t) => {
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

export interface ImageClampResult {
  images: EditorImage[];
  /** カット区間に完全に飲まれた（範囲外になった）画像の ID。 */
  flaggedIds: number[];
}

/**
 * カット区間と重なる画像の端を区間外へ寄せる。
 * 完全に飲まれた画像は flaggedIds へ入れ、画像自体は原形のまま残す
 * （SE と同じく ImageSegment スキーマには originalStart 退避が無いため、保存時は
 *  clampImages を経ずに projectImages → 最寄り再生フレームへ寄せて出力する。
 *  UI ではタイムラインで flagged ブロックとして警告表示する）。
 */
export function clampImages(images: EditorImage[], regions: CutRegion[]): ImageClampResult {
  const cuts = normalizeCutRegions(regions);
  const flaggedIds: number[] = [];
  const result = images.map((t) => {
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
  return { images: result, flaggedIds };
}

/** 原本フレーム区間の両端がカット区間内に落ちているか（UI の warning 表示用）。 */
export function imageInCutRegion(
  originalStart: number,
  originalEnd: number,
  regions: CutRegion[],
): boolean {
  const startIn = originalToPlayback(originalStart, regions) === null;
  const endIn = originalToPlayback(Math.max(originalStart, originalEnd - 1), regions) === null;
  return startIn && endIn;
}
