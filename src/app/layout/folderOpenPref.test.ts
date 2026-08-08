import { describe, it, expect, beforeEach, vi } from 'vitest';
import { loadFolderOpen, saveFolderOpen } from './folderOpenPref';

describe('load/saveFolderOpen', () => {
  beforeEach(() => {
    const store: Record<string, string> = {};
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v; },
    });
  });
  it('既定は開', () => expect(loadFolderOpen()).toBe(true));
  it('閉→保存往復', () => { saveFolderOpen(false); expect(loadFolderOpen()).toBe(false); });
  it('開→保存往復', () => { saveFolderOpen(false); saveFolderOpen(true); expect(loadFolderOpen()).toBe(true); });
  it('localStorage 不可でも開にフォールバック', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } });
    expect(loadFolderOpen()).toBe(true);
    expect(() => saveFolderOpen(false)).not.toThrow();
  });
});
