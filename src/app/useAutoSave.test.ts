/**
 * @vitest-environment jsdom
 */
/**
 * useAutoSave フックのユニットテスト。
 * 判定ロジック本体は edit/autoSave.ts の純関数（autoSave.test.ts）でカバー済み。
 * ここでは「タイマーで実際に save() を呼ぶ」「連続編集で再スケジュールされる」
 * 「フォーカスがテキスト編集要素にある間は延期される」という副作用込みの振る舞いを検証する。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useAutoSave } from './useAutoSave';
import { AUTO_SAVE_DELAY_MS, MAX_AUTO_SAVE_DEFERRALS } from './edit/autoSave';

describe('useAutoSave', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('dirty のまま静止時間が経過すると save() が呼ばれる', () => {
    const save = vi.fn().mockResolvedValue(true);
    renderHook(() =>
      useAutoSave({ enabled: true, dirty: true, saveStatus: 'idle', state: { v: 1 }, save }),
    );
    vi.advanceTimersByTime(AUTO_SAVE_DELAY_MS);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('連続編集中（state が変わり続ける）は発火せず、静止してから発火する', () => {
    const save = vi.fn().mockResolvedValue(true);
    const { rerender } = renderHook(
      ({ state }) => useAutoSave({ enabled: true, dirty: true, saveStatus: 'idle', state, save }),
      { initialProps: { state: { v: 1 } } },
    );
    // 静止時間の半分だけ経過 → まだ発火しない
    vi.advanceTimersByTime(AUTO_SAVE_DELAY_MS / 2);
    expect(save).not.toHaveBeenCalled();
    // ここで新しい編集が入る（state 変化）→ タイマーがリセットされる
    rerender({ state: { v: 2 } });
    vi.advanceTimersByTime(AUTO_SAVE_DELAY_MS / 2);
    expect(save).not.toHaveBeenCalled();
    // 残りの静止時間が経過すれば発火する
    vi.advanceTimersByTime(AUTO_SAVE_DELAY_MS / 2);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('トグル OFF のときは発火しない', () => {
    const save = vi.fn().mockResolvedValue(true);
    renderHook(() =>
      useAutoSave({ enabled: false, dirty: true, saveStatus: 'idle', state: { v: 1 }, save }),
    );
    vi.advanceTimersByTime(AUTO_SAVE_DELAY_MS * 2);
    expect(save).not.toHaveBeenCalled();
  });

  it('dirty でなければ発火しない', () => {
    const save = vi.fn().mockResolvedValue(true);
    renderHook(() =>
      useAutoSave({ enabled: true, dirty: false, saveStatus: 'idle', state: { v: 1 }, save }),
    );
    vi.advanceTimersByTime(AUTO_SAVE_DELAY_MS * 2);
    expect(save).not.toHaveBeenCalled();
  });

  it('直近の保存が失敗（error）していたら自動リトライしない', () => {
    const save = vi.fn().mockResolvedValue(true);
    renderHook(() =>
      useAutoSave({ enabled: true, dirty: true, saveStatus: 'error', state: { v: 1 }, save }),
    );
    vi.advanceTimersByTime(AUTO_SAVE_DELAY_MS * 2);
    expect(save).not.toHaveBeenCalled();
  });

  it('発火時にフォーカスがテキスト編集要素にあれば延期し、外れたら発火する', () => {
    const save = vi.fn().mockResolvedValue(true);
    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    textarea.focus();

    renderHook(() =>
      useAutoSave({ enabled: true, dirty: true, saveStatus: 'idle', state: { v: 1 }, save }),
    );
    vi.advanceTimersByTime(AUTO_SAVE_DELAY_MS);
    expect(save).not.toHaveBeenCalled();

    // フォーカスを外す → 次のチェックタイミングで発火する
    textarea.blur();
    vi.advanceTimersByTime(AUTO_SAVE_DELAY_MS);
    expect(save).toHaveBeenCalledTimes(1);

    document.body.removeChild(textarea);
  });

  it('入力欄にカーソルを残したままでも、延期の上限を超えたら保存する（data-safety-10）', () => {
    const save = vi.fn().mockResolvedValue(true);
    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    textarea.focus();

    renderHook(() =>
      useAutoSave({ enabled: true, dirty: true, saveStatus: 'idle', state: { v: 1 }, save }),
    );
    // 上限に達するまでは延期されたまま。
    vi.advanceTimersByTime(AUTO_SAVE_DELAY_MS * (MAX_AUTO_SAVE_DEFERRALS - 1));
    expect(save).not.toHaveBeenCalled();
    // 上限に達したチェックで保存が走る。
    vi.advanceTimersByTime(AUTO_SAVE_DELAY_MS);
    expect(save).toHaveBeenCalledTimes(1);

    document.body.removeChild(textarea);
  });

  it('IME 変換中は上限を超えても保存しない（変換を壊さない）', () => {
    const save = vi.fn().mockResolvedValue(true);
    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    textarea.focus();

    renderHook(() =>
      useAutoSave({ enabled: true, dirty: true, saveStatus: 'idle', state: { v: 1 }, save }),
    );
    window.dispatchEvent(new Event('compositionstart'));
    vi.advanceTimersByTime(AUTO_SAVE_DELAY_MS * (MAX_AUTO_SAVE_DEFERRALS + 3));
    expect(save).not.toHaveBeenCalled();

    // 変換が確定すれば次のチェックで保存される。
    window.dispatchEvent(new Event('compositionend'));
    vi.advanceTimersByTime(AUTO_SAVE_DELAY_MS);
    expect(save).toHaveBeenCalledTimes(1);

    document.body.removeChild(textarea);
  });

  it('IME 変換中に state が動いて再レンダーされても、変換が終わるまで blur で保存しない', () => {
    const save = vi.fn().mockResolvedValue(true);
    const { rerender } = renderHook(
      ({ state }) => useAutoSave({ enabled: true, dirty: true, saveStatus: 'idle', state, save }),
      { initialProps: { state: { v: 1 } } },
    );
    window.dispatchEvent(new Event('compositionstart'));
    // 変換中の onChange で state が変わる（保存 effect が貼り直される）。
    rerender({ state: { v: 2 } });
    window.dispatchEvent(new Event('blur'));
    expect(save).not.toHaveBeenCalled();
    // 変換が確定してからの blur は保存する。
    window.dispatchEvent(new Event('compositionend'));
    window.dispatchEvent(new Event('blur'));
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('ウィンドウのフォーカスが外れたら静止時間を待たずに保存する', () => {
    const save = vi.fn().mockResolvedValue(true);
    renderHook(() =>
      useAutoSave({ enabled: true, dirty: true, saveStatus: 'idle', state: { v: 1 }, save }),
    );
    window.dispatchEvent(new Event('blur'));
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('タブが隠れたら保存する（表示に戻るだけでは保存しない）', () => {
    const save = vi.fn().mockResolvedValue(true);
    renderHook(() =>
      useAutoSave({ enabled: true, dirty: true, saveStatus: 'idle', state: { v: 1 }, save }),
    );
    const setVisibility = (v: 'visible' | 'hidden'): void => {
      Object.defineProperty(document, 'visibilityState', { value: v, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    };
    setVisibility('visible');
    expect(save).not.toHaveBeenCalled();
    setVisibility('hidden');
    expect(save).toHaveBeenCalledTimes(1);
    setVisibility('visible');
  });

  it('delayMs を指定すると既定の AUTO_SAVE_DELAY_MS ではなくその時間で発火する（e2e 短縮用）', () => {
    const save = vi.fn().mockResolvedValue(true);
    renderHook(() =>
      useAutoSave({
        enabled: true,
        dirty: true,
        saveStatus: 'idle',
        state: { v: 1 },
        save,
        delayMs: 500,
      }),
    );
    vi.advanceTimersByTime(499);
    expect(save).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(save).toHaveBeenCalledTimes(1);
  });
});
