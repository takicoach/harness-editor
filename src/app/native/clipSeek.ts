/** 仕上げモードで実際に画面へ出ているプログラム区間（`NativeTimeline` の `displayPieces` の一部）。 */
export interface ClipSeekPiece { startFrame: number; endFrame: number }
export type ClipSeekResult = { frame: number } | { frame: null; reason: string };

export const CLIP_SEEK_CUT_REASON = 'この字幕はカットされた部分にあります。カットを戻すと表示できます。';

/**
 * 選んだ字幕が画面に出ている状態にするための再生位置。
 *
 * 候補は「字幕区間と可視ピースの**交差**」に限る。中点がカット済みでも全ピースの最寄りへ逃げない
 * （逃げると字幕区間の外へ出る）。中点は入場アニメーション（最大 24fr）より後になるので、
 * 送ったあとは文字が出ている。
 */
export function clipSeekTarget(clip: {startFrame: number; durationFrames: number}, currentFrame: number, pieces: ClipSeekPiece[] | null): ClipSeekResult {
  const start = clip.startFrame, end = clip.startFrame + clip.durationFrames;
  const source = pieces ?? [{startFrame: start, endFrame: end}];
  const visible: ClipSeekPiece[] = [];
  for (const piece of source) {
    const from = Math.max(start, piece.startFrame), to = Math.min(end, piece.endFrame);
    if (to > from) visible.push({startFrame: from, endFrame: to});
  }
  if (!visible.length) return {frame: null, reason: CLIP_SEEK_CUT_REASON};
  if (visible.some(piece => currentFrame >= piece.startFrame && currentFrame < piece.endFrame)) return {frame: null, reason: ''};
  if (clip.durationFrames === 1) return {frame: visible[0]!.startFrame};
  const total = visible.reduce((sum, piece) => sum + (piece.endFrame - piece.startFrame), 0);
  let offset = Math.floor(total / 2);
  for (const piece of visible) {
    const length = piece.endFrame - piece.startFrame;
    if (offset < length) return {frame: piece.startFrame + offset};
    offset -= length;
  }
  return {frame: visible[visible.length - 1]!.endFrame - 1};
}
