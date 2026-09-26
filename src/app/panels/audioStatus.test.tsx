/**
 * @vitest-environment jsdom
 */
/**
 * status-ia-7: ノイズ除去・音量調整の実行中／失敗が、閉じたセクションの中にしか
 * 出ない状態を解消したことの pin。
 *  (1) DenoiseBanner / NormalizeBanner の error 分岐に「もう一度」「閉じる」がある
 *  (2) dismissError が error → idle へ戻す（applied は保つ）
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup, renderHook, act } from '@testing-library/react';
import { DenoiseBanner } from './DenoiseBanner';
import { NormalizeBanner } from './NormalizeBanner';
import { useDenoise } from '../useDenoise';
import type { DenoiseState } from '../useDenoise';
import type { NormalizeState } from '../useNormalize';

afterEach(cleanup);

const noop = () => {};

describe('失敗バナーの再試行・閉じる（status-ia-7）', () => {
  it('DenoiseBanner の error に「もう一度」「閉じる」が出て、それぞれ呼ばれる', () => {
    const onRetry = vi.fn();
    const onDismiss = vi.fn();
    const state: DenoiseState = {
      status: 'error',
      error: { code: 'boom', message: '失敗しました' },
      applied: false,
    };
    const { getByTestId } = render(
      <DenoiseBanner
        state={state}
        onReloadRequested={noop}
        onCancel={noop}
        onRetry={onRetry}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.click(getByTestId('denoise-retry'));
    fireEvent.click(getByTestId('denoise-dismiss'));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('NormalizeBanner の error にも同じ 2 つが出る', () => {
    const onRetry = vi.fn();
    const onDismiss = vi.fn();
    const state: NormalizeState = {
      status: 'error',
      error: { code: 'boom', message: '失敗しました' },
      applied: true,
    };
    const { getByTestId } = render(
      <NormalizeBanner
        state={state}
        onReloadRequested={noop}
        onCancel={noop}
        onRetry={onRetry}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.click(getByTestId('normalize-retry'));
    fireEvent.click(getByTestId('normalize-dismiss'));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('ハンドラ未指定なら再試行・閉じるボタンは出ない（既存呼び出し面の互換）', () => {
    const state: DenoiseState = {
      status: 'error',
      error: { code: 'boom', message: '失敗しました' },
      applied: false,
    };
    const { queryByTestId } = render(
      <DenoiseBanner state={state} onReloadRequested={noop} onCancel={noop} />,
    );
    expect(queryByTestId('denoise-retry')).toBeNull();
    expect(queryByTestId('denoise-dismiss')).toBeNull();
  });
});

describe('useDenoise().dismissError（status-ia-7）', () => {
  it('error を idle へ戻し、applied は保つ', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: 'boom' }) }),
    );
    const { result } = renderHook(() => useDenoise('p1', true));

    await act(async () => {
      await result.current.start('mid');
    });
    expect(result.current.state.status).toBe('error');

    act(() => {
      result.current.dismissError();
    });
    expect(result.current.state.status).toBe('idle');
    expect(result.current.state.applied).toBe(true);
  });
});
