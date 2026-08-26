/**
 * @vitest-environment jsdom
 */
/**
 * 「表示したら既読」型の NEW バッジ（チュートリアルのように項目を開くこと自体が確認になる画面）。
 * 表示した回だけバッジを出し、その場で既読にする＝次回以降は出ない。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { CURRENT_FEATURE_GENERATION, isFeatureSeen, markFeatureSeen } from './featureSeen';
import { useFeatureBadge } from './useFeatureBadge';

beforeEach(() => {
  localStorage.clear();
});

describe('useFeatureBadge', () => {
  it('新機能を初めて表示した時はバッジを出し、その場で既読にする', () => {
    const { result } = renderHook(() => useFeatureBadge('board', CURRENT_FEATURE_GENERATION));
    expect(result.current).toBe(true);
    expect(isFeatureSeen('tutorial', 'board')).toBe(true);
  });

  it('既読にするのは tutorial スコープだけ（同じ id の図鑑側 NEW を消さない）', () => {
    renderHook(() => useFeatureBadge('board', CURRENT_FEATURE_GENERATION));
    expect(isFeatureSeen('help', 'board')).toBe(false);
  });

  it('図鑑側で既読でも、チュートリアルでは初回バッジが出る', () => {
    markFeatureSeen('help', 'board');
    const { result } = renderHook(() => useFeatureBadge('board', CURRENT_FEATURE_GENERATION));
    expect(result.current).toBe(true);
  });

  it('既読の項目ではバッジを出さない', () => {
    markFeatureSeen('tutorial', 'board');
    const { result } = renderHook(() => useFeatureBadge('board', CURRENT_FEATURE_GENERATION));
    expect(result.current).toBe(false);
  });

  it('新機能でない項目はバッジも既読化もしない', () => {
    const { result } = renderHook(() => useFeatureBadge('timeline', undefined));
    expect(result.current).toBe(false);
    expect(isFeatureSeen('tutorial', 'timeline')).toBe(false);
  });

  it('id が null（表示中の項目なし）なら何もしない', () => {
    const { result } = renderHook(() => useFeatureBadge(null, CURRENT_FEATURE_GENERATION));
    expect(result.current).toBe(false);
  });

  it('別項目へ移ると判定し直す（前の項目のバッジを引きずらない）', () => {
    markFeatureSeen('tutorial', 'seen-one');
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useFeatureBadge(id, CURRENT_FEATURE_GENERATION),
      { initialProps: { id: 'fresh-one' } },
    );
    expect(result.current).toBe(true);
    rerender({ id: 'seen-one' });
    expect(result.current).toBe(false);
  });
});
