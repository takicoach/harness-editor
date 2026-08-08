import { describe, it, expect } from 'vitest';
import { shouldShowBgmInstallWarning } from './BgmInstallBanner';

describe('shouldShowBgmInstallWarning', () => {
  it('BGM クリップがあり未導入なら警告する', () => {
    expect(shouldShowBgmInstallWarning(1, false)).toBe(true);
    expect(shouldShowBgmInstallWarning(3, false)).toBe(true);
  });

  it('BGM クリップが無ければ警告しない', () => {
    expect(shouldShowBgmInstallWarning(0, false)).toBe(false);
  });

  it('導入済みなら（BGM があっても）警告しない', () => {
    expect(shouldShowBgmInstallWarning(2, true)).toBe(false);
    expect(shouldShowBgmInstallWarning(0, true)).toBe(false);
  });
});
