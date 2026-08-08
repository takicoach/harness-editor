import { describe, it, expect, beforeEach, vi } from 'vitest';
import { loadAutoSaveEnabled, saveAutoSaveEnabled, hasExplicitAutoSavePref } from './autoSavePref';

describe('load/saveAutoSaveEnabled', () => {
  beforeEach(() => {
    const store: Record<string, string> = {};
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v; },
    });
  });

  it('既定は ON（未設定）', () => expect(loadAutoSaveEnabled()).toBe(true));
  it('OFF を保存して読み戻せる', () => {
    saveAutoSaveEnabled(false);
    expect(loadAutoSaveEnabled()).toBe(false);
  });
  it('ON を保存して読み戻せる', () => {
    saveAutoSaveEnabled(true);
    expect(loadAutoSaveEnabled()).toBe(true);
  });
});

describe('hasExplicitAutoSavePref', () => {
  beforeEach(() => {
    const store: Record<string, string> = {};
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v; },
    });
  });

  it('未設定なら false（ユーザーが明示選択していない＝サーバ既定値を適用してよい）', () => {
    expect(hasExplicitAutoSavePref()).toBe(false);
  });

  it('保存済み（ON/OFF どちらでも）なら true', () => {
    saveAutoSaveEnabled(false);
    expect(hasExplicitAutoSavePref()).toBe(true);
  });
});
