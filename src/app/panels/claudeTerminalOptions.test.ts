import { describe, it, expect } from 'vitest';
import { TERMINAL_FONT_FAMILY, terminalOptions, terminalTheme } from './claudeTerminalOptions';
import { TERMINAL_COLORS } from '../../shared/terminalColors';

describe('terminalOptions', () => {
  it('fontFamily を明示指定する（既定の generic "monospace" 丸投げは禁止）', () => {
    const opts = terminalOptions('dark');
    expect(opts.fontFamily).toBe(TERMINAL_FONT_FAMILY);
    expect(opts.fontFamily.length).toBeGreaterThan(0);
  });

  it('先頭が ui-monospace（OS標準等幅フォントを指す既定値）であること', () => {
    expect(TERMINAL_FONT_FAMILY.split(',')[0]?.trim()).toBe('ui-monospace');
  });

  it('macOS 向けの明示フォールバック（Menlo/SF Mono系）を含む', () => {
    expect(TERMINAL_FONT_FAMILY).toMatch(/SF Mono/);
    expect(TERMINAL_FONT_FAMILY).toMatch(/Menlo/);
  });

  it('Windows 向けの等幅フォントを含む（配布対象OS）', () => {
    expect(TERMINAL_FONT_FAMILY).toMatch(/Cascadia Mono/);
    expect(TERMINAL_FONT_FAMILY).toMatch(/Consolas/);
  });

  it('Linux 向けの等幅フォントを含む（配布対象OS）', () => {
    expect(TERMINAL_FONT_FAMILY).toMatch(/DejaVu Sans Mono/);
    expect(TERMINAL_FONT_FAMILY).toMatch(/Liberation Mono/);
  });

  it('最後は総称ファミリー monospace で閉じる（未知環境への最終フォールバック）', () => {
    expect(TERMINAL_FONT_FAMILY.trim().endsWith('monospace')).toBe(true);
  });

  it('テーマは従来通り light/dark で配色が変わる（回帰無しの確認）', () => {
    expect(terminalTheme('light')).toEqual({ background: '#ffffff', foreground: '#1a1a1a', cursor: '#1a1a1a' });
    expect(terminalTheme('dark')).toEqual({
      background: '#101418', foreground: '#ffffff', cursor: '#ffffff',
    });
  });

  it('fontSize は 12 / convertEol は false のまま（回帰無しの確認）', () => {
    const opts = terminalOptions('dark');
    expect(opts.fontSize).toBe(12);
    expect(opts.convertEol).toBe(false);
  });
});

describe('terminalTheme と OSC 応答の出所が一致する', () => {
  it('light の背景が TERMINAL_COLORS.light と同じ', () => {
    expect(terminalTheme('light').background).toBe(TERMINAL_COLORS.light.background);
    expect(terminalTheme('light').foreground).toBe(TERMINAL_COLORS.light.foreground);
  });
  it('dark の背景が TERMINAL_COLORS.dark と同じ', () => {
    expect(terminalTheme('dark').background).toBe(TERMINAL_COLORS.dark.background);
    expect(terminalTheme('dark').foreground).toBe(TERMINAL_COLORS.dark.foreground);
  });
});
