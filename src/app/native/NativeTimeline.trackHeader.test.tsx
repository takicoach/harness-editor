/** @vitest-environment jsdom */
// src/app/native/NativeTimeline.trackHeader.test.tsx
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { NativeTimeline } from './NativeTimeline';
import type { SequenceDocument } from '../../core/sequence/model';
import { rational as r } from '../../core/sequence/time';

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', () => 1); vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

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

it('ヘッダーは種別色で染まり、表示トグルが左端にある', () => {
  const view = setup();
  const trackEl = view.container.querySelector<HTMLElement>('[data-native-track="v"]')!;
  expect(trackEl.style.getPropertyValue('--track-accent')).toBe('var(--track-telop)');
  const label = trackEl.querySelector<HTMLElement>('.native-track-label')!;
  const eye = view.getByLabelText('字幕を無効にする');
  expect(eye.className).toContain('native-track-toggle');
  expect(eye.getAttribute('data-kind')).toBe('eye');
  expect(eye.getAttribute('aria-pressed')).toBe('true');
  expect(label.firstElementChild!.contains(eye)).toBe(true);
});

it('音声トラックの M は押下＝ミュート', () => {
  const view = setup();
  const mute = view.getByLabelText('原音を有効にする');
  expect(mute.getAttribute('data-kind')).toBe('mute');
  expect(mute.getAttribute('aria-pressed')).toBe('true');
  expect(view.container.querySelector('[data-native-track="a"]')!.getAttribute('style')).toContain('--track-bgm');
});

it('並べ替えと削除はアイコンボタンで、削除は danger', () => {
  const view = setup();
  expect(view.getByLabelText('字幕を削除').className).toContain('btn-danger');
  expect(view.getByLabelText('字幕を上へ移動').querySelector('svg')).not.toBeNull();
});
