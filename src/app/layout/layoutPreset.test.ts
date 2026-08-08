import { describe, it, expect, beforeEach, vi } from 'vitest';
import { showsSubtitlePanel, loadLayout, saveLayout, type LayoutPreset } from './layoutPreset';
import type { EditState } from '../edit/editState';

function mk(selection: EditState['selection'], telops: Array<{ id: number; manual?: boolean }> = []): EditState {
  return { selection, telops } as unknown as EditState;
}
const subtitleSel = mk({ kind: 'telop', id: 1 }, [{ id: 1, manual: false }]);
const bgmSel = mk({ kind: 'bgm', id: 1 });

describe('showsSubtitlePanel', () => {
  it('subtitle モード＋字幕選択は true', () => expect(showsSubtitlePanel(subtitleSel, 'subtitle')).toBe(true));
  it('subtitle モード＋BGM は false', () => expect(showsSubtitlePanel(bgmSel, 'subtitle')).toBe(false));
  it('subtitle モード＋未選択は false', () => expect(showsSubtitlePanel(mk(null), 'subtitle')).toBe(false));
  it('standard モードは字幕でも false', () => expect(showsSubtitlePanel(subtitleSel, 'standard')).toBe(false));
  it('tall-dock モードは字幕でも false', () => expect(showsSubtitlePanel(subtitleSel, 'tall-dock')).toBe(false));
  it('waveform モードは字幕でも false', () => expect(showsSubtitlePanel(subtitleSel, 'waveform')).toBe(false));
});

describe('load/saveLayout', () => {
  beforeEach(() => {
    const store: Record<string, string> = {};
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v; },
    });
  });
  it('既定は standard', () => expect(loadLayout()).toBe('standard'));
  it('不正値は standard', () => { saveLayout('xxx' as LayoutPreset); expect(loadLayout()).toBe('standard'); });
  it('保存往復', () => { saveLayout('tall-dock'); expect(loadLayout()).toBe('tall-dock'); saveLayout('subtitle'); expect(loadLayout()).toBe('subtitle'); saveLayout('waveform'); expect(loadLayout()).toBe('waveform'); });
});
