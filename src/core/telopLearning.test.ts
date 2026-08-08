import { describe, expect, it } from 'vitest';
import { diffTelopData } from './telopLearning';
import type { TelopSegment } from './types';

function seg(id: number, startFrame: number, endFrame: number, text: string): TelopSegment {
  return { id, startFrame, endFrame, text };
}

describe('diffTelopData', () => {
  it('同じ区間でテキストが変わっていれば changed を返す', () => {
    const baseline = [seg(1, 0, 30, '素振りする')];
    const current = [seg(1, 0, 30, '素振りをする')];
    expect(diffTelopData(baseline, current)).toEqual([
      { kind: 'changed', startFrame: 0, endFrame: 30, before: '素振りする', after: '素振りをする' },
    ]);
  });

  it('同じ区間でテキストが同じなら差分なし', () => {
    const baseline = [seg(1, 0, 30, '同じ')];
    const current = [seg(1, 0, 30, '同じ')];
    expect(diffTelopData(baseline, current)).toEqual([]);
  });

  it('baseline のみに存在する区間は removed', () => {
    const baseline = [seg(1, 0, 30, '消えた')];
    const current: TelopSegment[] = [];
    expect(diffTelopData(baseline, current)).toEqual([
      { kind: 'removed', startFrame: 0, endFrame: 30, before: '消えた', after: '' },
    ]);
  });

  it('current のみに存在する区間は added', () => {
    const baseline: TelopSegment[] = [];
    const current = [seg(1, 0, 30, '追加された')];
    expect(diffTelopData(baseline, current)).toEqual([
      { kind: 'added', startFrame: 0, endFrame: 30, before: '', after: '追加された' },
    ]);
  });

  it('複数区間はオーバーラップ最大のものでペアになる', () => {
    const baseline = [seg(1, 0, 30, 'A')];
    const current = [seg(1, 0, 10, 'B'), seg(2, 5, 35, 'C')];
    const result = diffTelopData(baseline, current);
    expect(result).toContainEqual({ kind: 'changed', startFrame: 5, endFrame: 35, before: 'A', after: 'C' });
    expect(result).toContainEqual({ kind: 'added', startFrame: 0, endFrame: 10, before: '', after: 'B' });
    expect(result).toHaveLength(2);
  });

  it('空配列同士は空配列', () => {
    expect(diffTelopData([], [])).toEqual([]);
  });
});
