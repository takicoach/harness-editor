import { describe, expect, it } from 'vitest';
import {
  isOverlapKind, buildOverlaps, finalTotalFrames, playbackToFinal, finalToPlayback,
  type PlaybackOverlap,
} from './transitionEngine';
import type { SceneTransition } from './types';

const segs = [
  { playbackStart: 0, playbackEnd: 100 },
  { playbackStart: 100, playbackEnd: 200 },
  { playbackStart: 200, playbackEnd: 300 },
];

describe('isOverlapKind', () => {
  it('重なる系のみ true', () => {
    expect(isOverlapKind('crossfade')).toBe(true);
    expect(isOverlapKind('slide')).toBe(true);
    expect(isOverlapKind('wipe')).toBe(true);
    expect(isOverlapKind('fadeBlack')).toBe(false);
    expect(isOverlapKind('fadeWhite')).toBe(false);
    expect(isOverlapKind('fadeColor')).toBe(false);
  });
});

describe('buildOverlaps', () => {
  it('重なる系のみ・境界一致・boundary昇順', () => {
    const t: SceneTransition[] = [
      { id: 1, at: 100, kind: 'crossfade', durationFrames: 20 },
      { id: 2, at: 200, kind: 'fadeBlack', durationFrames: 30 }, // fade は overlap 0
    ];
    expect(buildOverlaps(t, segs)).toEqual([{ boundary: 100, overlap: 20 }]);
  });
  it('上限クランプ＝隣接区間の短い方の半分', () => {
    // 区間長 100/100 → 上限 50。durationFrames 80 は 50 へ。
    const t: SceneTransition[] = [{ id: 1, at: 100, kind: 'slide', durationFrames: 80 }];
    expect(buildOverlaps(t, segs)).toEqual([{ boundary: 100, overlap: 50 }]);
  });
  it('境界に一致しない at は除外', () => {
    const t: SceneTransition[] = [{ id: 1, at: 137, kind: 'wipe', durationFrames: 10 }];
    expect(buildOverlaps(t, segs)).toEqual([]);
  });
  it('head/tail は除外', () => {
    const t: SceneTransition[] = [{ id: 1, at: 'head', kind: 'fadeBlack', durationFrames: 10 }];
    expect(buildOverlaps(t, segs)).toEqual([]);
  });
});

describe('finalTotalFrames', () => {
  it('Σoverlap を引く', () => {
    expect(finalTotalFrames(300, [{ boundary: 100, overlap: 20 }])).toBe(280);
    expect(finalTotalFrames(300, [{ boundary: 100, overlap: 20 }, { boundary: 200, overlap: 30 }])).toBe(250);
  });
  it('overlap なしは恒等', () => {
    expect(finalTotalFrames(300, [])).toBe(300);
  });
});

describe('playbackToFinal', () => {
  const ov: PlaybackOverlap[] = [{ boundary: 100, overlap: 20 }];
  it('境界前は不変', () => {
    expect(playbackToFinal(50, ov)).toBe(50);
    expect(playbackToFinal(99, ov)).toBe(99);
  });
  it('境界以後は overlap 分前へ', () => {
    expect(playbackToFinal(100, ov)).toBe(80);
    expect(playbackToFinal(200, ov)).toBe(180);
  });
  it('複数 overlap は累積', () => {
    const ov2: PlaybackOverlap[] = [{ boundary: 100, overlap: 20 }, { boundary: 200, overlap: 30 }];
    expect(playbackToFinal(250, ov2)).toBe(200); // 250 - 20 - 30
  });
  it('overlap なしは恒等', () => {
    expect(playbackToFinal(123, [])).toBe(123);
  });
});

describe('finalToPlayback round-trip（窓の外）', () => {
  const ov: PlaybackOverlap[] = [{ boundary: 100, overlap: 20 }];
  // 注: P=100（=boundary）と [100,120) は重なり窓内なので往復不成立＝仕様（窓内は一意でない）。
  // 窓内の値をこのリストに足すと回帰テストが壊れるので追加しないこと。
  it('窓外で playbackToFinal の逆', () => {
    for (const p of [0, 50, 99, 120, 150, 200, 299]) {
      expect(finalToPlayback(playbackToFinal(p, ov), ov)).toBe(p);
    }
  });
  it('複数 overlap でも窓外で逆', () => {
    const ov2: PlaybackOverlap[] = [{ boundary: 100, overlap: 20 }, { boundary: 200, overlap: 30 }];
    for (const p of [0, 50, 130, 199, 230, 299]) {
      expect(finalToPlayback(playbackToFinal(p, ov2), ov2)).toBe(p);
    }
  });
});
