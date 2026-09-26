/**
 * @vitest-environment jsdom
 */
/**
 * status-ia-12: ダイアログの閉じ方・初期フォーカス・aria-modal を
 * ヘルプ／作成モーダルと同じ規則に揃えたことの pin。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { ExportDialog } from './ExportDialog';
import { TrashConfirmDialog } from './TrashConfirmDialog';
import { focusableIn } from '../useFocusTrap';

afterEach(cleanup);

const noop = () => {};

function renderExport(onClose: () => void) {
  return render(
    <ExportDialog
      orientation="portrait"
      width={1080}
      height={1920}
      onStart={noop}
      onClose={onClose}
    />,
  );
}

describe('ExportDialog（status-ia-12）', () => {
  it('Escape で閉じる', () => {
    const onClose = vi.fn();
    renderExport(onClose);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('IME 変換中の Escape では閉じない', () => {
    const onClose = vi.fn();
    renderExport(onClose);
    fireEvent.keyDown(window, { key: 'Escape', isComposing: true });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('aria-modal を持ち、初期フォーカスはキャンセル', () => {
    const { getByTestId, container } = renderExport(noop);
    expect(getByTestId('export-dialog').getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(container.querySelector('.export-cancel'));
  });
});

describe('TrashConfirmDialog（status-ia-12）', () => {
  it('Escape でキャンセルされ、aria-modal を持つ', () => {
    const onCancel = vi.fn();
    const { getByTestId } = render(
      <TrashConfirmDialog
        name="a.mp4"
        usedCount={0}
        mode="trash"
        onConfirm={noop}
        onCancel={onCancel}
      />,
    );
    expect(getByTestId('trash-confirm-dialog').getAttribute('aria-modal')).toBe('true');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('送信中（busy）は Escape で閉じない（二重送信・誤操作の防止）', () => {
    const onCancel = vi.fn();
    render(
      <TrashConfirmDialog
        name="a.mp4"
        usedCount={0}
        mode="purge"
        busy
        onConfirm={noop}
        onCancel={onCancel}
      />,
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onCancel).not.toHaveBeenCalled();
  });
});

describe('aria-modal を名乗るダイアログは Tab を閉じ込める（サイクル 3 残 Minor）', () => {
  it('書き出しダイアログ: 末尾で Tab を押しても外へ抜けない', () => {
    const { getByTestId } = renderExport(noop);
    const dialog = getByTestId('export-dialog');
    const items = focusableIn(dialog);
    expect(items.length).toBeGreaterThan(1);
    (items[items.length - 1] as HTMLElement).focus();
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(items[0]);
  });

  it('削除確認ダイアログ: 先頭で Shift+Tab を押しても外へ抜けない', () => {
    const { getByTestId } = render(
      <TrashConfirmDialog
        name="a.mp4"
        usedCount={0}
        mode="trash"
        onConfirm={noop}
        onCancel={noop}
      />,
    );
    const dialog = getByTestId('trash-confirm-dialog');
    const items = focusableIn(dialog);
    expect(items.length).toBeGreaterThan(1);
    (items[0] as HTMLElement).focus();
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(items[items.length - 1]);
  });
});
