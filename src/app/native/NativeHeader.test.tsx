/** @vitest-environment jsdom */
// src/app/native/NativeHeader.test.tsx
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { NativeHeader, type NativeHeaderProps } from './NativeHeader';

afterEach(cleanup);
function props(extra: Partial<NativeHeaderProps> = {}): NativeHeaderProps {
  return { title: '2026-09-14-C0123', saveState: 'saved', mode: 'edit', onMode: vi.fn(), canUndo: true, canRedo: false, busy: false, onUndo: vi.fn(), onRedo: vi.fn(),
    onHome: vi.fn(), onActivity: vi.fn(), onSettings: vi.fn(), settingsOpen: false, onSave: vi.fn(), saveDisabled: false, exportControl: <button className="btn-primary">書き出し</button>,
    autoSave: true, onAutoSave: vi.fn(), ...extra };
}

it('左＝場所・中央＝モード・右＝行動の順に並び、自動保存は設定と保存の間にある', () => {
  const view = render(<NativeHeader {...props()} />);
  const names = view.getAllByRole('button').map(b => b.getAttribute('aria-label') ?? b.textContent);
  expect(names).toEqual(['ホームに戻る', '確認', '編集', '仕上げ', '元に戻す', 'やり直す', 'AIの作業', '設定', '保存', '書き出し']);
  expect(view.getByRole('button', { name: '編集' }).getAttribute('aria-current')).toBe('page');
  const actions = view.container.querySelector('.native-header-actions')!;
  const order = [...actions.children].map(node => node.className);
  expect(order.findIndex(c => c.includes('native-auto-save'))).toBe(order.findIndex(c => c.includes('btn-tonal')) - 1);
  expect(view.getByLabelText('自動保存')).toBeTruthy();
});

it('自動保存スイッチの変更が親へ渡る', () => {
  const p = props();
  const view = render(<NativeHeader {...p} />);
  fireEvent.click(view.getByLabelText('自動保存'));
  expect(p.onAutoSave).toHaveBeenCalledWith(false);
});

it('ボタンの階層: AI は secondary・保存は tonal・Undo/Redo は ghost の 1 組', () => {
  const view = render(<NativeHeader {...props()} />);
  expect(view.getByRole('button', { name: 'AIの作業' }).className).toContain('btn-secondary');
  expect(view.getByText('保存').closest('button')!.className).toContain('btn-tonal');
  const group = view.container.querySelector('.native-btn-group')!;
  expect(group.querySelectorAll('button.btn-ghost')).toHaveLength(2);
  expect((view.getByLabelText('やり直す') as HTMLButtonElement).disabled).toBe(true);
});

it('保存状態は点と文言で示す', () => {
  const view = render(<NativeHeader {...props({ saveState: 'dirty' })} />);
  const state = view.container.querySelector('.native-save-state')!;
  expect(state.className).toContain('native-save-dirty');
  expect(state.textContent).toBe('未保存の変更');
  expect(state.querySelector('.native-save-dot')).not.toBeNull();
});

it('操作はコールバックへ渡る', () => {
  const p = props();
  const view = render(<NativeHeader {...p} />);
  fireEvent.click(view.getByLabelText('元に戻す')); fireEvent.click(view.getByText('保存')); fireEvent.click(view.getByRole('button', { name: '仕上げ' }));
  expect(p.onUndo).toHaveBeenCalled(); expect(p.onSave).toHaveBeenCalled(); expect(p.onMode).toHaveBeenCalledWith('finish');
});

it('モードは「ワークスペース」navigation ランドマークの中にある', () => {
  const view = render(<NativeHeader {...props()} />);
  const nav = view.getByRole('navigation', { name: 'ワークスペース' });
  const editButton = view.getByRole('button', { name: '編集' });
  expect(nav.contains(editButton)).toBe(true);
  expect(editButton.getAttribute('aria-current')).toBe('page');
});

it('places notification history immediately before settings and opens it independently',()=>{
 const onNotifications=vi.fn(),view=render(<NativeHeader {...props({onNotifications,unreadNotifications:2})}/>);
 const button=view.getByRole('button',{name:'通知・エラー履歴'});
 expect(button.nextElementSibling).toBe(view.getByRole('button',{name:'設定'}));
 expect(button.textContent).toContain('2');fireEvent.click(button);expect(onNotifications).toHaveBeenCalledOnce();
});

it('data-compact でも自動保存とAIの作業のアクセシブル名は残る', () => {
  const view = render(<NativeHeader {...props()} />);
  view.container.querySelector('header')!.setAttribute('data-compact', 'true');
  expect(view.getByRole('checkbox', { name: '自動保存' })).toBeTruthy();
  expect(view.getByRole('button', { name: 'AIの作業' })).toBeTruthy();
});
it('shows save progress on the right only for an actual save, with an accessible percentage',()=>{
 const view=render(<NativeHeader {...props({saveState:'busy',busy:true})}/>);
 expect(view.queryByRole('progressbar',{name:'保存中'})).toBeNull();
 view.rerender(<NativeHeader {...props({saveState:'busy',busy:true,saveProgress:30})}/>);
 const progress=view.getByRole('progressbar',{name:'保存中'});
 expect(progress.getAttribute('aria-valuenow')).toBe('30');expect(progress.textContent).toBe('保存中 30%');
 expect(progress.closest('.native-header-actions')).not.toBeNull();expect(view.queryByRole('button',{name:'保存'})).toBeNull();
 view.rerender(<NativeHeader {...props({saveProgress:100})}/>);
 expect(view.getByRole('progressbar',{name:'保存完了'}).getAttribute('aria-valuenow')).toBe('100');
 view.rerender(<NativeHeader {...props()}/>);expect(view.getByRole('button',{name:'保存'})).toBeDefined();
});

it('「？」（使い方（ヘルプ））は通知・エラー履歴の右隣、設定の左にあり、押すと onHelp が呼ばれる', () => {
  const onHelp = vi.fn();
  const view = render(<NativeHeader {...props({ onNotifications: vi.fn(), onHelp })} />);
  const help = view.getByRole('button', { name: '使い方（ヘルプ）' });
  expect(help.previousElementSibling).toBe(view.getByRole('button', { name: '通知・エラー履歴' }));
  expect(help.nextElementSibling).toBe(view.getByRole('button', { name: '設定' }));
  expect(help.getAttribute('data-tutorial')).toBe('help');
  expect(help.getAttribute('title')).toBe('使い方（ヘルプ）');
  expect(help.querySelector('path')?.getAttribute('d')).toContain('M12 3a9 9 0 1 0 0 18');
  fireEvent.click(help);
  expect(onHelp).toHaveBeenCalledOnce();
});
