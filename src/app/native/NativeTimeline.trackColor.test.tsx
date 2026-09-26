/** @vitest-environment jsdom */
// src/app/native/NativeTimeline.trackColor.test.tsx
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { NativeTimeline } from './NativeTimeline';
import type { SequenceDocument } from '../../core/sequence/model';
import { rational as r } from '../../core/sequence/time';

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', () => 1); vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  localStorage.clear();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

function fixture(): SequenceDocument {
  return { schemaVersion: 2, id: 'doc', name: 'fixture', revision: 0, fps: r(30), resolution: { width: 320, height: 180 }, sequenceEndFrame: 3000, background: '#000',
    assets: [], transcripts: [], transitions: [], ducking: { enabled: false, strength: 'mid' },
    tracks: [{ id: 'v', kind: 'visual', name: '字幕', enabled: true }, { id: 'a', kind: 'audio', name: '原音', enabled: false }],
    clips: [{ id: 'c', trackId: 'v', name: '字幕A', startFrame: 300, durationFrames: 100, clock: { offset: r(0), rate: r(1), duration: r(100) }, content: { kind: 'telop', data: { text: 'A' } } }] };
}
function setup() {
  return render(<NativeTimeline projectId="p" document={fixture()} waveform="standard" frame={0} selected={[]} range={null} tool="select" zoom={1} snap={false}
    onSelect={vi.fn()} onRange={vi.fn()} onSeek={vi.fn()} onDrop={vi.fn()} onCommand={vi.fn(async () => true)} onZoomChange={vi.fn()} />);
}

it('色点ボタンでメニューが開き、9色と自動に戻すが出る', () => {
  const view = setup();
  fireEvent.click(view.getByRole('button', { name: '字幕の色' }));
  const menu = view.getByRole('menu', { name: '字幕の色' });
  expect(menu).toBeTruthy();
  expect(view.getAllByRole('menuitemradio').length).toBe(9);
  expect(view.getByRole('menuitem', { name: '自動に戻す' })).toBeTruthy();
});

it('スウォッチを選ぶとトラックのアクセントが変わりメニューが閉じる', () => {
  const view = setup();
  fireEvent.click(view.getByRole('button', { name: '字幕の色' }));
  fireEvent.click(view.getByRole('menuitemradio', { name: '青（字幕）' }));
  const trackEl = view.container.querySelector<HTMLElement>('[data-native-track="v"]')!;
  expect(trackEl.style.getPropertyValue('--track-accent')).toBe('var(--track-jimaku)');
  expect(view.queryByRole('menu', { name: '字幕の色' })).toBeNull();
});

it('自動に戻すで上書きが消える', () => {
  const view = setup();
  fireEvent.click(view.getByRole('button', { name: '字幕の色' }));
  fireEvent.click(view.getByRole('menuitemradio', { name: '青（字幕）' }));
  const trackEl = view.container.querySelector<HTMLElement>('[data-native-track="v"]')!;
  expect(trackEl.style.getPropertyValue('--track-accent')).toBe('var(--track-jimaku)');
  fireEvent.click(view.getByRole('button', { name: '字幕の色' }));
  fireEvent.click(view.getByRole('menuitem', { name: '自動に戻す' }));
  expect(trackEl.style.getPropertyValue('--track-accent')).toBe('var(--track-telop)');
});

it('Escapeで閉じてフォーカスが色点ボタンに戻る', () => {
  const view = setup();
  const trigger = view.getByRole('button', { name: '字幕の色' });
  fireEvent.click(trigger);
  const menu = view.getByRole('menu', { name: '字幕の色' });
  fireEvent.keyDown(menu, { key: 'Escape' });
  expect(view.queryByRole('menu', { name: '字幕の色' })).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it('矢印キーで次のスウォッチへフォーカスが移る', () => {
  const view = setup();
  fireEvent.click(view.getByRole('button', { name: '字幕の色' }));
  const menu = view.getByRole('menu', { name: '字幕の色' });
  const items = view.getAllByRole('menuitemradio');
  expect(document.activeElement).toBe(items[0]);
  fireEvent.keyDown(menu, { key: 'ArrowRight' });
  expect(document.activeElement).toBe(items[1]);
});

it('外側クリックでメニューが閉じる', () => {
  const view = setup();
  fireEvent.click(view.getByRole('button', { name: '字幕の色' }));
  expect(view.getByRole('menu', { name: '字幕の色' })).toBeTruthy();
  fireEvent.pointerDown(document.body);
  expect(view.queryByRole('menu', { name: '字幕の色' })).toBeNull();
});
