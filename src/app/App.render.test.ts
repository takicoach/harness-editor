/**
 * App.tsx の書き出し開始判定（shouldProceedToRender）のユニットテスト。
 * useEditSession.save() が Promise<boolean>（保存成否）を返す契約になったことを受け、
 * 「dirty かつ保存失敗」では render を開始しないことを固定する。
 */
import { describe, it, expect } from 'vitest';
import { shouldProceedToRender, isConvertingSelected, installingKindFor } from './App';

describe('shouldProceedToRender', () => {
  it('dirty でなければ save 結果に関わらず開始する', () => {
    expect(shouldProceedToRender(false, true)).toBe(true);
    expect(shouldProceedToRender(false, false)).toBe(true);
  });

  it('dirty かつ保存成功なら開始する', () => {
    expect(shouldProceedToRender(true, true)).toBe(true);
  });

  it('dirty かつ保存失敗なら開始しない（stale saveError 対策の核心）', () => {
    expect(shouldProceedToRender(true, false)).toBe(false);
  });
});

describe('isConvertingSelected', () => {
  it('converting が選択中プロジェクトと一致すれば true', () => {
    expect(isConvertingSelected('proj-a', 'proj-a')).toBe(true);
  });

  it('converting が別プロジェクトなら false（切替時の誤スピナー防止）', () => {
    expect(isConvertingSelected('proj-a', 'proj-b')).toBe(false);
  });

  it('converting が null なら false', () => {
    expect(isConvertingSelected(null, 'proj-a')).toBe(false);
  });

  it('selectedId が null なら false', () => {
    expect(isConvertingSelected('proj-a', null)).toBe(false);
  });
});

describe('installingKindFor', () => {
  it('installing が選択中プロジェクト向けなら kind を返す', () => {
    expect(installingKindFor({ kind: 'bgm', projectId: 'proj-a' }, 'proj-a')).toBe('bgm');
  });

  it('installing が別プロジェクト向けなら null（切替時の誤スピナー防止）', () => {
    expect(installingKindFor({ kind: 'bgm', projectId: 'proj-a' }, 'proj-b')).toBeNull();
  });

  it('installing が null なら null', () => {
    expect(installingKindFor(null, 'proj-a')).toBeNull();
  });

  it('selectedId が null なら null', () => {
    expect(installingKindFor({ kind: 'bgm', projectId: 'proj-a' }, null)).toBeNull();
  });
});
