/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NativeAnimationGuard, type AnimationGuardRequest } from './NativeAnimationGuard';

afterEach(cleanup);

const request = (overrides: Partial<AnimationGuardRequest> = {}): AnimationGuardRequest => ({
  title: '動きが使えない組み合わせ', detail: 'このスタイルの部品はこの動きに対応していません。',
  keepLabel: '動きを保持して変更を中止', clearLabel: '動きを解除して変更',
  onKeep: vi.fn(), onClear: vi.fn(), ...overrides,
});

describe('非対応のときの 2 択', () => {
  it('理由が常時読める文として出る（title 属性だけに置かない）', () => {
    render(<NativeAnimationGuard request={request()} onDismiss={vi.fn()} />);
    const dialog = screen.getByRole('alertdialog', { name: '動きが使えない組み合わせ' });
    expect(dialog.textContent).toContain('このスタイルの部品はこの動きに対応していません。');
  });

  it('「保持して中止」は何も変えない', () => {
    const onKeep = vi.fn(), onClear = vi.fn(), onDismiss = vi.fn();
    render(<NativeAnimationGuard request={request({ onKeep, onClear })} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole('button', { name: '動きを保持して変更を中止' }));
    expect(onKeep).toHaveBeenCalledOnce(); expect(onClear).not.toHaveBeenCalled(); expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('「解除して変更」は 1 回だけ実行される', () => {
    const onClear = vi.fn();
    render(<NativeAnimationGuard request={request({ onClear })} onDismiss={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '動きを解除して変更' }));
    expect(onClear).toHaveBeenCalledOnce();
  });

  it('要求が無ければ何も描かない', () => {
    const { container } = render(<NativeAnimationGuard request={null} onDismiss={vi.fn()} />);
    expect(container.innerHTML).toBe('');
  });

  it('Escape で閉じると「保持して中止」と同じ扱いになる', () => {
    const onKeep = vi.fn(), onClear = vi.fn(), onDismiss = vi.fn();
    render(<NativeAnimationGuard request={request({ onKeep, onClear })} onDismiss={onDismiss} />);
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });
    expect(onKeep).toHaveBeenCalledOnce(); expect(onClear).not.toHaveBeenCalled(); expect(onDismiss).toHaveBeenCalledOnce();
  });

  // M-5' / R2 Rec 2: 変換中の Esc は IME のもの。ここで閉じると、変換を取り消しただけで 2 択が消える。
  it('IME の変換中の Escape では閉じない', () => {
    const onKeep = vi.fn(), onDismiss = vi.fn();
    render(<NativeAnimationGuard request={request({ onKeep })} onDismiss={onDismiss} />);
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape', isComposing: true });
    expect(onKeep).not.toHaveBeenCalled(); expect(onDismiss).not.toHaveBeenCalled();
  });

  it('「閉じる」ボタンでも「保持して中止」と同じ扱いになる', () => {
    const onKeep = vi.fn(), onClear = vi.fn(), onDismiss = vi.fn();
    render(<NativeAnimationGuard request={request({ onKeep, onClear })} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole('button', { name: '動きの確認を閉じる' }));
    expect(onKeep).toHaveBeenCalledOnce(); expect(onClear).not.toHaveBeenCalled(); expect(onDismiss).toHaveBeenCalledOnce();
  });
});
