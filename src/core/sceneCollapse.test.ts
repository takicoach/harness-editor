import { describe, expect, it } from 'vitest';
import { collapseTelops, collapseSe, collapseImages } from './sceneCollapse';
import type { PlaybackOverlap } from './transitionEngine';
import type { TelopSegment } from './types';

const ov: PlaybackOverlap[] = [{ boundary: 100, overlap: 20 }];

describe('collapseTelops', () => {
  const base: TelopSegment = {
    id: 1, startFrame: 150, endFrame: 200, text: 'a',
    originalStart: 500, originalEnd: 560,
  } as TelopSegment;
  it('境界以後の再生フレームを最終へ写す', () => {
    const [r] = collapseTelops([base], ov);
    expect(r!.startFrame).toBe(130);
    expect(r!.endFrame).toBe(180);
  });
  it('originalStart/End は不変', () => {
    const [r] = collapseTelops([base], ov);
    expect(r!.originalStart).toBe(500);
    expect(r!.originalEnd).toBe(560);
  });
  it('overlap 空は恒等', () => {
    expect(collapseTelops([base], [])).toEqual([base]);
  });
});

describe('collapseSe', () => {
  it('playbackFrame/playbackEnd を写す', () => {
    const se = [{ id: 1, playbackFrame: 120, playbackEnd: 140, file: 'x.wav', volume: 1 }];
    const [r] = collapseSe(se, ov);
    expect(r!.playbackFrame).toBe(100);
    expect(r!.playbackEnd).toBe(120);
  });
});

describe('collapseImages', () => {
  it('playbackStart/playbackEnd を写す', () => {
    const im = [{ id: 1, playbackStart: 130, playbackEnd: 160, file: 'p.png', type: 'photo' as const, scale: 1 }];
    const [r] = collapseImages(im, ov);
    expect(r!.playbackStart).toBe(110);
    expect(r!.playbackEnd).toBe(140);
  });
});
