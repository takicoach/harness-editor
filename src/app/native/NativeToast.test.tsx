/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NativeToast } from './NativeToast';

beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanup(); vi.useRealTimers(); });

it('3 秒で自動的に閉じ、role=status で読み上げる', () => {
  const onClose = vi.fn();
  const view = render(<NativeToast message="AIの編集内容を保存しました" onClose={onClose} />);
  expect(view.getByRole('status').textContent).toContain('AIの編集内容を保存しました');
  act(() => { vi.advanceTimersByTime(2999); }); expect(onClose).not.toHaveBeenCalled();
  act(() => { vi.advanceTimersByTime(1); }); expect(onClose).toHaveBeenCalledTimes(1);
});

it('操作ボタンを押すと action が呼ばれて閉じ、ホバー中は閉じない', () => {
  const onClose = vi.fn(), onClick = vi.fn();
  const view = render(<NativeToast message="字幕を 3 件削除しました" action={{ label: '元に戻す', onClick }} onClose={onClose} />);
  fireEvent.pointerEnter(view.getByRole('status'));
  act(() => { vi.advanceTimersByTime(5000); }); expect(onClose).not.toHaveBeenCalled();
  fireEvent.click(view.getByRole('button', { name: '元に戻す' }));
  expect(onClick).toHaveBeenCalled(); expect(onClose).toHaveBeenCalled();
});

it('M-3: 同じ文言でも id が変われば表示時間を数え直す', () => {
  const onClose = vi.fn();
  const view = render(<NativeToast id={1} message="音声がない素材です。映像トラックへ配置してください。" onClose={onClose} />);
  act(() => { vi.advanceTimersByTime(2500); });
  view.rerender(<NativeToast id={2} message="音声がない素材です。映像トラックへ配置してください。" onClose={onClose} />);
  act(() => { vi.advanceTimersByTime(2999); }); expect(onClose).not.toHaveBeenCalled();
  act(() => { vi.advanceTimersByTime(1); }); expect(onClose).toHaveBeenCalledTimes(1);
});
