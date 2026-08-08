import { describe, it, expect } from 'vitest';
import { resolveInitialTheme, toggleTheme } from './theme';

describe('resolveInitialTheme', () => {
  it('保存値が light ならそれを優先（OS設定を無視）', () => {
    expect(resolveInitialTheme('light', true)).toBe('light');
  });
  it('保存値が dark ならそれを優先', () => {
    expect(resolveInitialTheme('dark', false)).toBe('dark');
  });
  it('未保存なら OS のダーク設定に追従（dark）', () => {
    expect(resolveInitialTheme(null, true)).toBe('dark');
  });
  it('未保存なら OS のダーク設定に追従（light）', () => {
    expect(resolveInitialTheme(null, false)).toBe('light');
  });
  it('無効な保存値は OS 設定にフォールバック', () => {
    expect(resolveInitialTheme('blue', false)).toBe('light');
  });
});

describe('toggleTheme', () => {
  it('dark → light', () => { expect(toggleTheme('dark')).toBe('light'); });
  it('light → dark', () => { expect(toggleTheme('light')).toBe('dark'); });
});
