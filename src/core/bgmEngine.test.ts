import { describe, expect, it, test } from 'vitest';
import { anchorBgm, projectBgm, clampBgm, bgmInCutRegion } from './bgmEngine';
import type { BgmClip, CutRegion } from './types';

const clip = (over: Partial<BgmClip> = {}): BgmClip => ({
  id: 1, file: 'a.mp3', startFrame: 100, endFrame: 300, volume: 0.3, fadeInFrames: 10, fadeOutFrames: 10, ...over,
});

describe('anchorBgm / projectBgm 往復', () => {
  it('カット無しは往復で不変', () => {
    const clips = [clip()];
    expect(projectBgm(anchorBgm(clips, []), [])).toEqual(clips);
  });

  it('カットありでも往復で不変（再生↔原本↔再生）＋ carry-through', () => {
    const regions: CutRegion[] = [{ start: 0, end: 50 }];
    const clips = [clip({ startFrame: 100, endFrame: 300 })];
    const projected = projectBgm(anchorBgm(clips, regions), regions);
    const p = projected[0]!;
    expect(p.startFrame).toBe(100); // 往復恒等
    expect(p.endFrame).toBe(300);
    expect(p.volume).toBe(0.3);     // carry-through
    expect(p.fadeInFrames).toBe(10);
    expect(p.fadeOutFrames).toBe(10);
  });

  it('anchor は再生フレームを原本フレームへ逆射影する（手前のカットぶん後ろへ）', () => {
    const regions: CutRegion[] = [{ start: 0, end: 50 }];
    const anchored = anchorBgm([clip({ startFrame: 100, endFrame: 300 })], regions);
    const a = anchored[0]!;
    expect(a.originalStart).toBe(150); // 100 + 50（手前で50カットされている＝原本では150）
    expect(a.originalEnd).toBe(350);
  });
});

describe('clampBgm', () => {
  it('カットに完全に飲まれたクリップは flagged', () => {
    // 原本区間 [100,300) がカット [90,320) に完全に含まれる
    const anchored = [{ ...clip(), originalStart: 100, originalEnd: 300 }];
    const { flaggedIds } = clampBgm(anchored, [{ start: 90, end: 320 }]);
    expect(flaggedIds).toContain(1);
  });

  it('飲まれていなければ flagged にならない', () => {
    const anchored = [{ ...clip(), originalStart: 100, originalEnd: 300 }];
    const { flaggedIds, bgm } = clampBgm(anchored, []);
    expect(flaggedIds).toHaveLength(0);
    expect(bgm).toHaveLength(1);
  });
});

describe('bgmInCutRegion', () => {
  it('原本区間がカットに完全に含まれるとき true', () => {
    expect(bgmInCutRegion(100, 300, [{ start: 90, end: 320 }])).toBe(true);
  });
  it('カット外なら false', () => {
    expect(bgmInCutRegion(100, 300, [{ start: 0, end: 50 }])).toBe(false);
  });
});

test('projectBgm は autoVolume を出力に含めない', () => {
  const out = projectBgm(
    [{ id: 1, originalStart: 0, originalEnd: 60, file: 'a.mp3', volume: 0.2, fadeInFrames: 0, fadeOutFrames: 0, autoVolume: true }],
    [],
  );
  expect('autoVolume' in (out[0] as object)).toBe(false);
});
