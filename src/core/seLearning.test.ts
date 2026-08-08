import { describe, expect, it } from 'vitest';
import { diffSeData } from './seLearning';
import type { SoundEffect, TelopSegment } from './types';

function se(id: number, startFrame: number, file: string, endFrame?: number): SoundEffect {
  return endFrame === undefined ? { id, startFrame, file } : { id, startFrame, endFrame, file };
}
function telop(id: number, startFrame: number, endFrame: number, text: string): TelopSegment {
  return { id, startFrame, endFrame, text };
}

describe('diffSeData', () => {
  it('current にのみ存在する SE は added（近傍テロップテキスト付き）', () => {
    const baseline: SoundEffect[] = [];
    const current = [se(1, 100, 'whoosh.mp3', 190)];
    const telops = [telop(1, 90, 200, 'ここでSE')];
    expect(diffSeData(baseline, current, telops)).toEqual([
      { kind: 'added', startFrame: 100, file: 'whoosh.mp3', nearbyText: 'ここでSE' },
    ]);
  });

  it('baseline にのみ存在する SE は removed', () => {
    const baseline = [se(1, 100, 'whoosh.mp3', 190)];
    const current: SoundEffect[] = [];
    const telops = [telop(1, 90, 200, 'ここでSE')];
    expect(diffSeData(baseline, current, telops)).toEqual([
      { kind: 'removed', startFrame: 100, file: 'whoosh.mp3', nearbyText: 'ここでSE' },
    ]);
  });

  it('同じファイル・重なる区間なら差分なし', () => {
    const baseline = [se(1, 100, 'whoosh.mp3', 190)];
    const current = [se(1, 100, 'whoosh.mp3', 190)];
    expect(diffSeData(baseline, current, [])).toEqual([]);
  });

  it('ファイルが違えば別物として扱う（重なっていても added/removed 両方）', () => {
    const baseline = [se(1, 100, 'a.mp3', 190)];
    const current = [se(1, 100, 'b.mp3', 190)];
    const result = diffSeData(baseline, current, []);
    expect(result).toContainEqual({ kind: 'removed', startFrame: 100, file: 'a.mp3', nearbyText: '' });
    expect(result).toContainEqual({ kind: 'added', startFrame: 100, file: 'b.mp3', nearbyText: '' });
  });

  it('近傍テロップが無ければ nearbyText は空文字', () => {
    const current = [se(1, 100, 'whoosh.mp3', 190)];
    expect(diffSeData([], current, [])).toEqual([
      { kind: 'added', startFrame: 100, file: 'whoosh.mp3', nearbyText: '' },
    ]);
  });

  it('endFrame 省略時は90フレーム区間として扱う', () => {
    const baseline = [se(1, 100, 'whoosh.mp3')];
    const current = [se(1, 100, 'whoosh.mp3')];
    expect(diffSeData(baseline, current, [])).toEqual([]);
  });
});
