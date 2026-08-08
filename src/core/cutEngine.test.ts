import { describe, it, expect } from 'vitest';
import { normalizeCutRegions, applyCuts } from './cutEngine';

describe('normalizeCutRegions', () => {
  it('start 順にソートする', () => {
    expect(normalizeCutRegions([{ start: 50, end: 60 }, { start: 10, end: 20 }])).toEqual([
      { start: 10, end: 20 },
      { start: 50, end: 60 },
    ]);
  });

  it('重複・隣接する区間をマージする', () => {
    expect(normalizeCutRegions([{ start: 10, end: 30 }, { start: 25, end: 40 }])).toEqual([
      { start: 10, end: 40 },
    ]);
  });

  it('空区間（start >= end）を除外する', () => {
    expect(normalizeCutRegions([{ start: 10, end: 10 }, { start: 5, end: 8 }])).toEqual([
      { start: 5, end: 8 },
    ]);
  });

  it('隣接する（接する）区間をマージする', () => {
    expect(normalizeCutRegions([{ start: 10, end: 20 }, { start: 20, end: 30 }])).toEqual([
      { start: 10, end: 30 },
    ]);
  });
});

describe('applyCuts', () => {
  it('カット無しは全体 1 区間を返す', () => {
    expect(applyCuts(1000, [])).toEqual([
      { id: 1, originalStart: 0, originalEnd: 1000, playbackStart: 0, playbackEnd: 1000 },
    ]);
  });

  it('中間のカットで 2 区間に分かれ playback が詰まる', () => {
    expect(applyCuts(1000, [{ start: 300, end: 500 }])).toEqual([
      { id: 1, originalStart: 0, originalEnd: 300, playbackStart: 0, playbackEnd: 300 },
      { id: 2, originalStart: 500, originalEnd: 1000, playbackStart: 300, playbackEnd: 800 },
    ]);
  });

  it('先頭のカットは最初の区間を消す', () => {
    expect(applyCuts(1000, [{ start: 0, end: 200 }])).toEqual([
      { id: 1, originalStart: 200, originalEnd: 1000, playbackStart: 0, playbackEnd: 800 },
    ]);
  });

  it('末尾までのカットは最後の区間を消す', () => {
    expect(applyCuts(1000, [{ start: 800, end: 1000 }])).toEqual([
      { id: 1, originalStart: 0, originalEnd: 800, playbackStart: 0, playbackEnd: 800 },
    ]);
  });
});

import { cutRegionsFromCutData, playbackTotalFrames } from './cutEngine';

describe('cutRegionsFromCutData', () => {
  it('残す区間の補集合を削除区間として返す', () => {
    const cutData = [
      { id: 1, originalStart: 0, originalEnd: 300, playbackStart: 0, playbackEnd: 300 },
      { id: 2, originalStart: 500, originalEnd: 1000, playbackStart: 300, playbackEnd: 800 },
    ];
    expect(cutRegionsFromCutData(cutData, 1000)).toEqual([{ start: 300, end: 500 }]);
  });

  it('末尾が残っていなければ末尾削除区間を含める', () => {
    const cutData = [
      { id: 1, originalStart: 0, originalEnd: 300, playbackStart: 0, playbackEnd: 300 },
    ];
    expect(cutRegionsFromCutData(cutData, 1000)).toEqual([{ start: 300, end: 1000 }]);
  });

  it('空 cutData はカット無し（空配列）', () => {
    expect(cutRegionsFromCutData([], 1000)).toEqual([]);
  });

  it('applyCuts と相互変換でラウンドトリップする', () => {
    const regions = [{ start: 300, end: 500 }];
    const cutData = applyCuts(1000, regions);
    expect(cutRegionsFromCutData(cutData, 1000)).toEqual(regions);
  });
});

describe('playbackTotalFrames', () => {
  it('原本からカット長を引いた値を返す', () => {
    expect(playbackTotalFrames(1000, [{ start: 300, end: 500 }])).toBe(800);
  });

  it('カット無しは原本尺と同じ', () => {
    expect(playbackTotalFrames(1000, [])).toBe(1000);
  });
});

import { materialBounds } from './cutEngine';

describe('materialBounds（素材＝残す区間の原本範囲）', () => {
  it('カット無しは [0, total]', () => {
    expect(materialBounds(1000, [])).toEqual({ start: 0, end: 1000 });
  });
  it('末尾カットは end が手前へ（末尾の素材なし領域を除く）', () => {
    expect(materialBounds(1000, [{ start: 800, end: 1000 }])).toEqual({ start: 0, end: 800 });
  });
  it('先頭カットは start が後ろへ', () => {
    expect(materialBounds(1000, [{ start: 0, end: 200 }])).toEqual({ start: 200, end: 1000 });
  });
  it('先頭・末尾の両方カット', () => {
    expect(materialBounds(1000, [{ start: 0, end: 200 }, { start: 800, end: 1000 }])).toEqual({
      start: 200,
      end: 800,
    });
  });
  it('中間カットは外周範囲に影響しない', () => {
    expect(materialBounds(1000, [{ start: 400, end: 600 }])).toEqual({ start: 0, end: 1000 });
  });
});

import { originalToPlayback, playbackToOriginal } from './cutEngine';

describe('originalToPlayback', () => {
  const regions = [{ start: 300, end: 500 }];

  it('カット前のフレームはそのまま', () => {
    expect(originalToPlayback(100, regions)).toBe(100);
  });

  it('カット後のフレームはカット長ぶん前へ詰まる', () => {
    expect(originalToPlayback(700, regions)).toBe(500);
  });

  it('カット区間内のフレームは null', () => {
    expect(originalToPlayback(400, regions)).toBeNull();
  });

  it('カット始端のフレームは null（カット区間内）', () => {
    expect(originalToPlayback(300, [{ start: 300, end: 500 }])).toBeNull();
  });

  it('カット終端のフレームはカット直後の再生フレームへ', () => {
    expect(originalToPlayback(500, [{ start: 300, end: 500 }])).toBe(300);
  });
});

describe('playbackToOriginal', () => {
  const regions = [{ start: 300, end: 500 }];

  it('カット前の再生フレームはそのまま', () => {
    expect(playbackToOriginal(100, regions)).toBe(100);
  });

  it('カット後の再生フレームは原本フレームへ戻る', () => {
    expect(playbackToOriginal(500, regions)).toBe(700);
  });

  it('originalToPlayback と往復一致する', () => {
    expect(playbackToOriginal(originalToPlayback(700, regions)!, regions)).toBe(700);
  });

  it('カット直後の再生フレームはカット終端の原本フレームへ', () => {
    expect(playbackToOriginal(300, [{ start: 300, end: 500 }])).toBe(500);
  });
});

import { addCutRegion, removeCutRegion } from './cutEngine';

describe('addCutRegion', () => {
  it('区間を追加し正規化する', () => {
    expect(addCutRegion([{ start: 10, end: 20 }], { start: 18, end: 30 })).toEqual([
      { start: 10, end: 30 },
    ]);
  });
});

describe('removeCutRegion', () => {
  it('完全一致する区間を取り除く', () => {
    expect(removeCutRegion([{ start: 10, end: 20 }], { start: 10, end: 20 })).toEqual([]);
  });

  it('区間の内側を抜くと 2 つに割れる', () => {
    expect(removeCutRegion([{ start: 10, end: 40 }], { start: 20, end: 30 })).toEqual([
      { start: 10, end: 20 },
      { start: 30, end: 40 },
    ]);
  });

  it('重ならない対象は無視する', () => {
    expect(removeCutRegion([{ start: 10, end: 20 }], { start: 50, end: 60 })).toEqual([
      { start: 10, end: 20 },
    ]);
  });
});
