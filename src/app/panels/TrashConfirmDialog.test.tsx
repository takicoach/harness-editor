/**
 * @vitest-environment jsdom
 *
 * 削除確認ダイアログの安全既定テスト。既定フォーカスがキャンセルであること（誤削除防止）と、
 * 送信中（busy）は両ボタンを押せないこと（連打で二重送信・二段目の警告読み飛ばしを防ぐ）。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { TrashConfirmDialog } from './TrashConfirmDialog';

afterEach(cleanup);

describe('TrashConfirmDialog', () => {
  it('既定フォーカスはキャンセル', () => {
    render(
      <TrashConfirmDialog name="a.mp3" usedCount={0} mode="trash" onConfirm={() => {}} onCancel={() => {}} />,
    );
    expect(document.activeElement).toBe(screen.getByText('キャンセル'));
  });

  it('busy のときは確認・キャンセルとも disabled（送信中の連打を止める）', () => {
    render(
      <TrashConfirmDialog
        name="a.mp3"
        usedCount={0}
        mode="trash"
        busy
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect((screen.getByTestId('trash-confirm-ok') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText('キャンセル') as HTMLButtonElement).disabled).toBe(true);
  });

  it('busy のときはオーバーレイのクリックでも閉じない', () => {
    const onCancel = vi.fn();
    const { container } = render(
      <TrashConfirmDialog
        name="a.mp3"
        usedCount={0}
        mode="trash"
        busy
        onConfirm={() => {}}
        onCancel={onCancel}
      />,
    );
    (container.querySelector('.hjc-overlay') as HTMLElement).click();
    expect(onCancel).not.toHaveBeenCalled();
  });
});
