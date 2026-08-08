import { describe, it, expect, vi, afterEach } from 'vitest';
import { DEFAULT_DUCKING, loadDuckingSettings, saveDuckingSettings } from './duckingSettings';

afterEach(() => vi.unstubAllGlobals());

describe('duckingSettings', () => {
  it('保存→読込で往復する', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    });
    saveDuckingSettings({ enabled: false, strength: 'strong' });
    expect(loadDuckingSettings()).toEqual({ enabled: false, strength: 'strong' });
  });
  it('未設定は既定', () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} });
    expect(loadDuckingSettings()).toEqual(DEFAULT_DUCKING);
  });
  it('不正値は既定', () => {
    vi.stubGlobal('localStorage', { getItem: () => '{bad', setItem: () => {} });
    expect(loadDuckingSettings()).toEqual(DEFAULT_DUCKING);
  });
  it('localStorage 不可でも既定を返す', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('no'); }, setItem: () => { throw new Error('no'); } });
    expect(loadDuckingSettings()).toEqual(DEFAULT_DUCKING);
    expect(() => saveDuckingSettings(DEFAULT_DUCKING)).not.toThrow();
  });
});
