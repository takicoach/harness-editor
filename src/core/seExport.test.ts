import { describe, expect, it } from 'vitest';
import { deriveSePlayback } from './seExport';
import type { EditorSe } from './types';

const se = (o: Partial<EditorSe>): EditorSe =>
  ({ id: 1, originalStart: 0, originalEnd: 90, file: 'beep.mp3', ...o }) as EditorSe;

describe('deriveSePlayback', () => {
  it('カット無しなら原本座標がそのまま再生座標になり volume は 1 に解決される', () => {
    const out = deriveSePlayback([se({ originalStart: 30, originalEnd: 120 })], [], undefined);
    expect(out).toEqual([
      { id: 1, playbackFrame: 30, playbackEnd: 120, file: 'beep.mp3', volume: 1,
        fadeInFrames: undefined, fadeOutFrames: undefined },
    ]);
  });
  it('カット区間に両端が飲まれた SE（縮退）は除外される', () => {
    const out = deriveSePlayback(
      [se({ originalStart: 100, originalEnd: 150 })],
      [{ start: 90, end: 200 }],
      undefined,
    );
    expect(out).toEqual([]);
  });
});
