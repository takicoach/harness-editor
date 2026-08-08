import { describe, it, expect } from 'vitest';
import { initialEditState } from './editState';
import { setSegmentSpeed, clearSegmentSpeed } from './segmentSpeedOps';
import type { EditorProject } from '../../core/types';

function baseState() {
  // segmentSpeeds 空で開始
  return initialEditState({ segmentSpeeds: {}, mainSpeed: 1 } as unknown as EditorProject);
}

describe('setSegmentSpeed', () => {
  it('区間 id に倍率を設定（クランプ）', () => {
    const s = setSegmentSpeed(baseState(), 3, 0.5);
    expect(s.segmentSpeeds).toEqual({ 3: 0.5 });
    const c = setSegmentSpeed(baseState(), 3, 999);
    expect(c.segmentSpeeds).toEqual({ 3: 16 });
  });
  it('同値なら参照不変（no-op）', () => {
    const s = setSegmentSpeed(baseState(), 3, 0.5);
    expect(setSegmentSpeed(s, 3, 0.5)).toBe(s);
  });
  it('非有限値は no-op', () => {
    const s = baseState();
    expect(setSegmentSpeed(s, 3, NaN)).toBe(s);
  });
});

describe('clearSegmentSpeed', () => {
  it('エントリを削除（全体に従うへ戻す）', () => {
    const s = setSegmentSpeed(baseState(), 3, 0.5);
    expect(clearSegmentSpeed(s, 3).segmentSpeeds).toEqual({});
  });
  it('存在しない id は参照不変', () => {
    const s = baseState();
    expect(clearSegmentSpeed(s, 99)).toBe(s);
  });
});
