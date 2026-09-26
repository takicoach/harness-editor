import { finalToPlayback, playbackToFinal, type PlaybackOverlap } from './transitionEngine';
import type { BgmClip, ImagePlayback, SePlayback, ShapeSegment, TelopSegment, TitleSegment, VideoInsertPlayback } from './types';

/** 再生フレーム→最終フレーム（意図明示エイリアス）。 */
export function collapseFrame(frame: number, overlaps: PlaybackOverlap[]): number {
  return playbackToFinal(frame, overlaps);
}

export function collapseTelops(telops: TelopSegment[], overlaps: PlaybackOverlap[]): TelopSegment[] {
  if (overlaps.length === 0) return telops;
  return telops.map((t) => ({
    ...t,
    startFrame: playbackToFinal(t.startFrame, overlaps),
    endFrame: playbackToFinal(t.endFrame, overlaps),
  }));
}

export function collapseTitles(titles: TitleSegment[], overlaps: PlaybackOverlap[]): TitleSegment[] {
  if (overlaps.length === 0) return titles;
  return titles.map((t) => ({
    ...t,
    startFrame: playbackToFinal(t.startFrame, overlaps),
    endFrame: playbackToFinal(t.endFrame, overlaps),
  }));
}

export function collapseShapes(shapes: ShapeSegment[], overlaps: PlaybackOverlap[]): ShapeSegment[] {
  if (overlaps.length === 0) return shapes;
  return shapes.map((s) => ({
    ...s,
    startFrame: playbackToFinal(s.startFrame, overlaps),
    endFrame: playbackToFinal(s.endFrame, overlaps),
  }));
}

export function collapseBgm(bgm: BgmClip[], overlaps: PlaybackOverlap[]): BgmClip[] {
  if (overlaps.length === 0) return bgm;
  return bgm.map((c) => ({
    ...c,
    startFrame: playbackToFinal(c.startFrame, overlaps),
    endFrame: playbackToFinal(c.endFrame, overlaps),
  }));
}

export function collapseSe(se: SePlayback[], overlaps: PlaybackOverlap[]): SePlayback[] {
  if (overlaps.length === 0) return se;
  return se.map((s) => ({
    ...s,
    playbackFrame: playbackToFinal(s.playbackFrame, overlaps),
    playbackEnd: playbackToFinal(s.playbackEnd, overlaps),
  }));
}

export function collapseImages(images: ImagePlayback[], overlaps: PlaybackOverlap[]): ImagePlayback[] {
  if (overlaps.length === 0) return images;
  return images.map((i) => ({
    ...i,
    playbackStart: playbackToFinal(i.playbackStart, overlaps),
    playbackEnd: playbackToFinal(i.playbackEnd, overlaps),
  }));
}

export function collapseVideoInserts(vi: VideoInsertPlayback[], overlaps: PlaybackOverlap[]): VideoInsertPlayback[] {
  if (overlaps.length === 0) return vi;
  return vi.map((v) => ({
    ...v,
    playbackStart: playbackToFinal(v.playbackStart, overlaps),
    playbackEnd: playbackToFinal(v.playbackEnd, overlaps),
  }));
}

/**
 * 汎用: `startFrame`/`endFrame` を持つ任意の core 型配列を再生→最終座標へ写す。
 * `...x` スプレッドで他フィールド（originalStart/End 等）は不変のまま通過する。
 * overlaps が空なら恒等（既存保存出力と byte 一致）。
 */
export function collapseStartEnd<T extends { startFrame: number; endFrame: number }>(
  arr: T[],
  overlaps: PlaybackOverlap[],
): T[] {
  if (overlaps.length === 0) return arr;
  return arr.map((x) => ({
    ...x,
    startFrame: playbackToFinal(x.startFrame, overlaps),
    endFrame: playbackToFinal(x.endFrame, overlaps),
  }));
}

/**
 * 汎用: `startFrame`/`endFrame` を持つ任意の core 型配列を最終→再生座標へ逆射影する。
 * `collapseStartEnd`（再生→最終）の対称関数。読込時に最終座標で保存されたデータを
 * 再生座標へ戻してから anchorX（再生→原本）へ渡す。
 * `...x` スプレッドで他フィールドは不変のまま通過する。
 * overlaps が空なら恒等（既存読込と一致・既存テストに影響なし）。
 */
export function uncollapseStartEnd<T extends { startFrame: number; endFrame: number }>(
  arr: T[],
  overlaps: PlaybackOverlap[],
): T[] {
  if (overlaps.length === 0) return arr;
  return arr.map((x) => ({
    ...x,
    startFrame: finalToPlayback(x.startFrame, overlaps),
    endFrame: finalToPlayback(x.endFrame, overlaps),
  }));
}
