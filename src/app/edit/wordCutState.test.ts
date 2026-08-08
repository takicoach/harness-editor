import { describe, expect, it } from 'vitest';
import { chipCutState } from './wordCutState';
import type { CutRegion, WordChip } from '../../core/types';

const chip = (s: number, e: number): WordChip => ({ text: 'x', originalStart: s, originalEnd: e });

describe('chipCutState', () => {
  it('チップ区間がカット区間に完全に含まれれば cut', () => {
    const regions: CutRegion[] = [{ start: 100, end: 200 }];
    expect(chipCutState(chip(120, 150), regions)).toBe(true);
  });

  it('チップ区間がカット区間と無関係なら not cut', () => {
    const regions: CutRegion[] = [{ start: 100, end: 200 }];
    expect(chipCutState(chip(300, 350), regions)).toBe(false);
  });

  it('チップ区間の端がカット境界とちょうど一致しても cut（境界含む）', () => {
    const regions: CutRegion[] = [{ start: 100, end: 200 }];
    expect(chipCutState(chip(100, 200), regions)).toBe(true);
  });

  it('部分的にしか重ならないチップは cut とみなさない（単語単位カットの整合）', () => {
    const regions: CutRegion[] = [{ start: 100, end: 200 }];
    expect(chipCutState(chip(150, 250), regions)).toBe(false);
  });

  it('カット区間が空なら常に not cut', () => {
    expect(chipCutState(chip(100, 200), [])).toBe(false);
  });
});
