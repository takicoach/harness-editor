import { normalizeCutRegions, originalToPlayback, playbackToOriginal } from './cutEngine';
import type { CutRegion, EditorShape, ShapeSegment } from './types';

/**
 * ShapeSegment[]（再生フレーム区間）を EditorShape[]（原本フレームアンカー）へ変換する。
 * 区間 [startFrame, endFrame) の両端を逆射影する。imageEngine の anchorImages と同じ要領。
 */
export function anchorShapes(shapes: ShapeSegment[], regions: CutRegion[]): EditorShape[] {
  return shapes.map((s) => {
    const { startFrame, endFrame, ...rest } = s;
    return {
      ...rest,
      originalStart: playbackToOriginal(startFrame, regions),
      originalEnd: playbackToOriginal(endFrame, regions),
    };
  });
}

/**
 * EditorShape[]（原本フレームアンカー）を ShapeSegment[]（再生フレーム）へ射影する。
 * アンカーがカット区間内に落ちた場合は最寄りの再生フレームへ丸める
 * （カット内図形は事前に clampShapes で寄せる想定）。
 */
export function projectShapes(shapes: EditorShape[], regions: CutRegion[]): ShapeSegment[] {
  return shapes.map((t) => {
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

export interface ShapeClampResult {
  shapes: EditorShape[];
  /** カット区間に完全に飲まれた（範囲外になった）図形の ID。 */
  flaggedIds: number[];
}

/**
 * カット区間と重なる図形の端を区間外へ寄せる。
 * 完全に飲まれた図形は flaggedIds へ入れ、図形自体は原形のまま残す
 * （imageEngine の clampImages と同じロジック。型のみ ShapeSegment/EditorShape を参照）。
 */
export function clampShapes(shapes: EditorShape[], regions: CutRegion[]): ShapeClampResult {
  const cuts = normalizeCutRegions(regions);
  const flaggedIds: number[] = [];
  const result = shapes.map((t) => {
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
  return { shapes: result, flaggedIds };
}

/** 原本フレーム区間の両端がカット区間内に落ちているか（UI の warning 表示用）。 */
export function shapeInCutRegion(
  originalStart: number,
  originalEnd: number,
  regions: CutRegion[],
): boolean {
  const startIn = originalToPlayback(originalStart, regions) === null;
  const endIn = originalToPlayback(Math.max(originalStart, originalEnd - 1), regions) === null;
  return startIn && endIn;
}
