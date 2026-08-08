import { describe, it, expect } from 'vitest';
import { regionKey, newRegionKeys, pulseKeysForChange } from './cutPulse';
import type { CutRegion } from '../../core/types';

const r = (start: number, end: number): CutRegion => ({ start, end });

describe('regionKey', () => {
  it('start-end 形式のキーを返す', () => {
    expect(regionKey(r(10, 20))).toBe('10-20');
  });
});

describe('newRegionKeys', () => {
  it('prev に無く next にある区間のキーだけを返す', () => {
    expect(newRegionKeys([r(0, 10)], [r(0, 10), r(30, 40)])).toEqual(['30-40']);
  });

  it('追加が無ければ空配列', () => {
    expect(newRegionKeys([r(0, 10)], [r(0, 10)])).toEqual([]);
  });

  it('区間が消えただけなら空配列', () => {
    expect(newRegionKeys([r(0, 10), r(30, 40)], [r(0, 10)])).toEqual([]);
  });
});

describe('pulseKeysForChange', () => {
  it('本数が増えた（カット新規追加）→ 追加キーを返す', () => {
    expect(pulseKeysForChange([r(0, 10)], [r(0, 10), r(30, 40)])).toEqual(['30-40']);
  });

  it('本数同じ（端調整 = resizeCutRegion 相当: prev [{0,10}] → next [{2,12}]）→ [] を返す', () => {
    expect(pulseKeysForChange([r(0, 10)], [r(2, 12)])).toEqual([]);
  });

  it('本数が減った（区間削除）→ [] を返す', () => {
    expect(pulseKeysForChange([r(0, 10), r(30, 40)], [r(0, 10)])).toEqual([]);
  });

  it('一度に複数区間追加 → 複数キーを返す', () => {
    expect(
      pulseKeysForChange([], [r(0, 10), r(30, 40)]),
    ).toEqual(['0-10', '30-40']);
  });
});
