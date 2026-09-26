import { describe, expect, it } from 'vitest';
import { deriveBgmPlayback } from './bgmExport';
import type { EditorBgmClip } from './types';

const clip = (o: Partial<EditorBgmClip>): EditorBgmClip =>
  ({ id: 1, file: 'bgm.mp3', originalStart: 0, originalEnd: 120,
     volume: 0.2, fadeInFrames: 0, fadeOutFrames: 0, ...o }) as EditorBgmClip;

describe('deriveBgmPlayback', () => {
  it('カット無しなら原本座標がそのまま再生座標になる', () => {
    const out = deriveBgmPlayback([clip({ originalStart: 30, originalEnd: 150 })], []);
    expect(out).toEqual([
      { id: 1, file: 'bgm.mp3', startFrame: 30, endFrame: 150,
        volume: 0.2, fadeInFrames: 0, fadeOutFrames: 0 },
    ]);
  });
  it('カットに両端が飲まれた縮退クリップは除外される', () => {
    const out = deriveBgmPlayback(
      [clip({ originalStart: 100, originalEnd: 150 })],
      [{ start: 90, end: 200 }],
    );
    expect(out).toEqual([]);
  });
});
