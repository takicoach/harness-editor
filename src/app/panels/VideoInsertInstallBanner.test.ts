import { describe, it, expect } from 'vitest';
import { shouldShowVideoInsertInstallWarning } from './VideoInsertInstallBanner';

describe('shouldShowVideoInsertInstallWarning', () => {
  it('サブ動画クリップがあり未導入なら警告する', () => {
    expect(shouldShowVideoInsertInstallWarning(1, false)).toBe(true);
    expect(shouldShowVideoInsertInstallWarning(3, false)).toBe(true);
  });

  it('サブ動画クリップが無ければ警告しない', () => {
    expect(shouldShowVideoInsertInstallWarning(0, false)).toBe(false);
  });

  it('導入済みなら（サブ動画があっても）警告しない', () => {
    expect(shouldShowVideoInsertInstallWarning(2, true)).toBe(false);
    expect(shouldShowVideoInsertInstallWarning(0, true)).toBe(false);
  });
});
