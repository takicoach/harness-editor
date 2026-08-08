import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  loadWaveformPref,
  saveWaveformPref,
  waveformTrackHeight,
  waveformCanvasHeight,
  waveformGain,
  type WaveformPref,
} from './waveformPref';

describe('load/saveWaveformPref', () => {
  beforeEach(() => {
    const store: Record<string, string> = {};
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v; },
    });
  });
  it('既定は standard', () => expect(loadWaveformPref()).toBe('standard'));
  it('不正値は standard', () => { saveWaveformPref('xxx' as WaveformPref); expect(loadWaveformPref()).toBe('standard'); });
  it('保存往復', () => { saveWaveformPref('large'); expect(loadWaveformPref()).toBe('large'); });
});

describe('waveformTrackHeight / waveformCanvasHeight / waveformGain', () => {
  it('standard は既存値のまま（トラック58px・canvas20px・gain1）', () => {
    expect(waveformTrackHeight('standard')).toBe(58);
    expect(waveformCanvasHeight('standard')).toBe(20);
    expect(waveformGain('standard')).toBe(1);
  });
  it('large はトラック・canvas・gain を拡大する', () => {
    expect(waveformTrackHeight('large')).toBe(96);
    expect(waveformCanvasHeight('large')).toBe(48);
    expect(waveformGain('large')).toBeGreaterThan(1);
  });
});
