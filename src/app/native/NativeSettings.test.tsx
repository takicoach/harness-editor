/** @vitest-environment jsdom */
// src/app/native/NativeSettings.test.tsx
import { cleanup, fireEvent, render, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { NativeSettings, type NativeSettingsProps } from './NativeSettings';
import { DEFAULT_PREFS } from '../layout/editorPrefs';

afterEach(cleanup);
function props(extra: Partial<NativeSettingsProps> = {}): NativeSettingsProps {
  return { prefs: DEFAULT_PREFS, onPrefs: vi.fn(), themePreference: 'system' as const, onTheme: vi.fn(), onOpenShortcuts: vi.fn(), onOpenHelp: vi.fn(), onClose: vi.fn(),
    panelLayout: 'standard', onPanelLayout: vi.fn(), ...extra };
}
function setup() {
  const p = props();
  return { p, view: render(<NativeSettings {...p} />) };
}

it('4 区分（表示・再生・操作音・ショートカット）を持つモーダルで、Esc で閉じる', () => {
  const { p, view } = setup();
  const dialog = view.getByRole('dialog', { name: '設定' });
  expect(dialog.getAttribute('aria-modal')).toBe('true');
  for (const h of ['表示', '再生', '操作音', 'ショートカット']) expect(view.getByRole('heading', { name: h })).toBeTruthy();
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(p.onClose).toHaveBeenCalled();
});

it('テーマ・密度・最高速度・操作音の変更がコールバックへ渡る', () => {
  const { p, view } = setup();
  fireEvent.click(view.getByRole('radio', { name: 'ダーク' })); expect(p.onTheme).toHaveBeenCalledWith('dark');
  fireEvent.click(view.getByRole('radio', { name: 'コンパクト' })); expect(p.onPrefs).toHaveBeenLastCalledWith({ ...DEFAULT_PREFS, density: 'compact' });
  fireEvent.click(view.getByRole('radio', { name: '4×' })); expect(p.onPrefs).toHaveBeenLastCalledWith({ ...DEFAULT_PREFS, shuttleMax: 4 });
  fireEvent.click(view.getByLabelText('操作音')); expect(p.onPrefs).toHaveBeenLastCalledWith({ ...DEFAULT_PREFS, sound: { enabled: false, kind: 'soft' } });
  fireEvent.click(view.getByLabelText('アニメーションを減らす')); expect(p.onPrefs).toHaveBeenLastCalledWith({ ...DEFAULT_PREFS, reduceMotion: true });
  fireEvent.click(view.getByRole('button', { name: /すべてのキー/ })); expect(p.onOpenShortcuts).toHaveBeenCalled();
});

it('「表示」区分に右パネル・タイムライン・セーフエリアが並ぶ', () => {
  const view = render(<NativeSettings {...props()} />);
  const display = view.getByRole('heading', { name: '表示' }).closest('section')!;
  expect(display.textContent).toContain('右パネル');
  expect(display.textContent).toContain('タイムライン');
  expect(within(display).getByLabelText('セーフエリアを表示')).toBeTruthy();
});

it('レイアウトの選択が親へ渡る', () => {
  const p = props();
  const view = render(<NativeSettings {...p} />);
  fireEvent.click(view.getByRole('button', { name: '縦長' }));
  expect(p.onPanelLayout).toHaveBeenCalledWith('tall-dock');
});

it('設定パネルの末尾にヘルプへの導線がある', () => {
  const p = props();
  const view = render(<NativeSettings {...p} />);
  fireEvent.click(view.getByRole('button', { name: '使い方を見る' }));
  expect(p.onOpenHelp).toHaveBeenCalled();
});

it('review モード（panelLayout=null）ではレイアウトを操作できない', () => {
  const view = render(<NativeSettings {...props({ panelLayout: null })} />);
  expect((view.getByRole('button', { name: '縦長' }) as HTMLButtonElement).disabled).toBe(true);
  expect((view.getByRole('button', { name: '全幅' }) as HTMLButtonElement).disabled).toBe(true);
});
