import { describe, expect, it, test } from 'vitest';
import { anchorSe, projectSe, clampSe, seInCutRegion } from './seAnchor';
import type { CutRegion, EditorSe, SoundEffect } from './types';

const REGIONS: CutRegion[] = [{ start: 100, end: 200 }];

describe('anchorSe', () => {
  it('再生フレームを原本フレームへ逆射影する（endFrame 無しは +90 補完）', () => {
    const se: SoundEffect[] = [
      { id: 1, startFrame: 50, file: 'a.mp3', volume: 0.3 },
      { id: 2, startFrame: 150, file: 'b.mp3' },
    ];
    expect(anchorSe(se, REGIONS)).toEqual([
      { id: 1, originalStart: 50, originalEnd: 140, file: 'a.mp3', volume: 0.3 },
      { id: 2, originalStart: 250, originalEnd: 340, file: 'b.mp3' },
    ]);
  });

  it('カット無しなら frame はそのまま（endFrame 無しは +90 補完）', () => {
    expect(anchorSe([{ id: 1, startFrame: 80, file: 'a.mp3' }], [])).toEqual([
      { id: 1, originalStart: 80, originalEnd: 170, file: 'a.mp3' },
    ]);
  });
});

describe('projectSe', () => {
  it('原本フレームを再生フレームへ射影する（両端・カット区間外）', () => {
    // REGIONS = [{ start: 100, end: 200 }] なので 50→50, 350→250 はカット外
    const se: EditorSe[] = [
      { id: 1, originalStart: 50, originalEnd: 99, file: 'a.mp3', volume: 0.3 },
      { id: 2, originalStart: 250, originalEnd: 350, file: 'b.mp3' },
    ];
    expect(projectSe(se, REGIONS)).toEqual([
      { id: 1, startFrame: 50, endFrame: 99, file: 'a.mp3', volume: 0.3 },
      { id: 2, startFrame: 150, endFrame: 250, file: 'b.mp3' },
    ]);
  });

  it('アンカーがカット区間内ならカット終端の再生フレームへ寄せる', () => {
    expect(projectSe([{ id: 1, originalStart: 150, originalEnd: 220, file: 'a.mp3' }], REGIONS)).toEqual([
      { id: 1, startFrame: 100, endFrame: 120, file: 'a.mp3' },
    ]);
  });

  it('anchorSe → projectSe は往復で一致する（カット外・endFrame あり）', () => {
    const se: SoundEffect[] = [{ id: 1, startFrame: 300, endFrame: 390, file: 'a.mp3', volume: 0.5 }];
    expect(projectSe(anchorSe(se, REGIONS), REGIONS)).toEqual(se);
  });
});

describe('seInCutRegion', () => {
  it('カット区間内の原本フレームは true', () => {
    expect(seInCutRegion(150, REGIONS)).toBe(true);
  });
  it('カット区間外は false', () => {
    expect(seInCutRegion(50, REGIONS)).toBe(false);
    expect(seInCutRegion(250, REGIONS)).toBe(false);
  });
  it('カット境界: start は区間内・end は区間外', () => {
    expect(seInCutRegion(100, REGIONS)).toBe(true);
    expect(seInCutRegion(200, REGIONS)).toBe(false);
  });
});

test('projectSe は両端を射影する（カット無し）', () => {
  const out = projectSe([{ id: 1, originalStart: 30, originalEnd: 120, file: 'a.mp3', volume: 0.3 }], []);
  expect(out).toEqual([{ id: 1, startFrame: 30, endFrame: 120, file: 'a.mp3', volume: 0.3 }]);
});

test('projectSe はフェードを通し autoLength を落とす', () => {
  const out = projectSe(
    [{ id: 2, originalStart: 0, originalEnd: 60, file: 'b.mp3', fadeInFrames: 5, fadeOutFrames: 8, autoLength: true }],
    [],
  );
  expect(out[0]).toEqual({ id: 2, startFrame: 0, endFrame: 60, file: 'b.mp3', fadeInFrames: 5, fadeOutFrames: 8 });
});

test('anchorSe は endFrame 無しを +90 で補完する（旧データ移行）', () => {
  const out = anchorSe([{ id: 1, startFrame: 30, file: 'a.mp3' }], []);
  expect(out[0]?.originalStart).toBe(30);
  expect(out[0]?.originalEnd).toBe(120);
});

test('anchorSe は endFrame ありをそのまま逆射影する', () => {
  const out = anchorSe([{ id: 1, startFrame: 30, endFrame: 200, file: 'a.mp3' }], []);
  expect(out[0]?.originalEnd).toBe(200);
});

test('projectSe は autoVolume を出力に含めない', () => {
  const out = projectSe([{ id: 1, originalStart: 0, originalEnd: 60, file: 'a.mp3', volume: 0.5, autoVolume: true }], []);
  expect('autoVolume' in (out[0] as object)).toBe(false);
});

test('clampSe は両端がカットに飲まれた区間を flag する', () => {
  // カット [50,100) に完全に収まる SE。
  const { flaggedIds } = clampSe([{ id: 9, originalStart: 60, originalEnd: 90, file: 'a.mp3' }], [{ start: 50, end: 100 }]);
  expect(flaggedIds).toContain(9);
});
