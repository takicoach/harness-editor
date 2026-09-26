/** @vitest-environment jsdom */
// src/app/native/NativeShortcutsDialog.test.tsx
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { NativeShortcutsDialog } from './NativeShortcutsDialog';

afterEach(cleanup);

it('ショートカット一覧が開き、Esc で閉じる', () => {
  const onClose = vi.fn();
  const view = render(<NativeShortcutsDialog onClose={onClose} />);
  const dialog = view.getByRole('dialog', { name: 'ショートカット一覧' });
  expect(dialog.getAttribute('aria-modal')).toBe('true');
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(onClose).toHaveBeenCalled();
});

it('onOpenHelp が無いときはヘルプ導線を出さない', () => {
  const view = render(<NativeShortcutsDialog onClose={vi.fn()} />);
  expect(view.queryByRole('button', { name: '使い方を見る' })).toBeNull();
});

it('ショートカット一覧からヘルプを開ける', () => {
  const onOpenHelp = vi.fn();
  const view = render(<NativeShortcutsDialog onClose={vi.fn()} onOpenHelp={onOpenHelp} />);
  fireEvent.click(view.getByRole('button', { name: '使い方を見る' }));
  expect(onOpenHelp).toHaveBeenCalled();
});
