import { describe, expect, it } from 'vitest';
import { shouldFireAutoSave, parseAutoSaveDelayOverride, type AutoSaveDecisionInput } from './autoSave';

function base(overrides: Partial<AutoSaveDecisionInput> = {}): AutoSaveDecisionInput {
  return {
    enabled: true,
    dirty: true,
    saveStatus: 'idle',
    focusInEditable: false,
    ...overrides,
  };
}

describe('shouldFireAutoSave', () => {
  it('全条件がそろえば発火する', () => {
    expect(shouldFireAutoSave(base())).toBe(true);
  });

  it('トグル OFF なら発火しない', () => {
    expect(shouldFireAutoSave(base({ enabled: false }))).toBe(false);
  });

  it('dirty でなければ発火しない（保存不要）', () => {
    expect(shouldFireAutoSave(base({ dirty: false }))).toBe(false);
  });

  it('保存中（saving）は発火しない（二重起動防止）', () => {
    expect(shouldFireAutoSave(base({ saveStatus: 'saving' }))).toBe(false);
  });

  it('直近の保存が失敗（error）していたら自動再試行しない', () => {
    expect(shouldFireAutoSave(base({ saveStatus: 'error' }))).toBe(false);
  });

  it('フォーカスがテキスト編集要素にある間は発火しない', () => {
    expect(shouldFireAutoSave(base({ focusInEditable: true }))).toBe(false);
  });
});

describe('parseAutoSaveDelayOverride', () => {
  it('クエリが無ければ null（既定値を使わせる）', () => {
    expect(parseAutoSaveDelayOverride('')).toBeNull();
  });

  it('autoSaveDelayMsForTest が正の数値なら採用する（e2e の待ち時間短縮用）', () => {
    expect(parseAutoSaveDelayOverride('?autoSaveDelayMsForTest=500')).toBe(500);
  });

  it('0 以下・非数値は無視して null', () => {
    expect(parseAutoSaveDelayOverride('?autoSaveDelayMsForTest=0')).toBeNull();
    expect(parseAutoSaveDelayOverride('?autoSaveDelayMsForTest=abc')).toBeNull();
  });
});
