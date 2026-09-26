import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** UI 添削 F1 / F15: 色の正本は styles.css だけ。native-polish.css の同名トークン上書き（フォーク）を禁止する。 */
const styles = readFileSync(join(__dirname, '..', 'styles.css'), 'utf8');
const polish = readFileSync(join(__dirname, 'native-polish.css'), 'utf8');
const nativeCss = readdirSync(__dirname).filter(f => f.endsWith('.css')).map(f => [f, readFileSync(join(__dirname, f), 'utf8')] as const);

function block(source: string, selector: RegExp): string {
  const m = source.match(new RegExp(`${selector.source}\\s*\\{([\\s\\S]*?)\\n\\}`));
  if (!m?.[1]) throw new Error(`${selector} が見つからない`);
  return m[1];
}
const dark = block(styles, /\n:root/), light = block(styles, /:root\[data-theme="light"\]/);
const read = (b: string, name: string) => b.match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1]?.trim();

describe('native トークン統合', () => {
  it('native-polish.css はトークンを上書きしない', () => {
    for (const t of ['--bg-0', '--bg-1', '--bg-2', '--bg-3', '--fg-0', '--fg-1', '--fg-2', '--accent', '--panel-shadow', '--audio-fill', '--audio-border']) expect(polish, t).not.toContain(`${t}:`);
    expect(polish).not.toMatch(/font-family/);
    expect(polish).not.toMatch(/radial-gradient/);
  });
  it('styles.css が添削の確定値を持つ', () => {
    expect(read(light, 'bg-0')).toBe('#F2F4F3'); expect(read(dark, 'bg-0')).toBe('#101312');
    expect(read(light, 'accent')).toBe('#17825B'); expect(read(dark, 'accent')).toBe('#63CFA7');
    expect(read(light, 'border')).toBe('#C1CCC8'); expect(read(dark, 'border')).toBe('#3B4541');
    // I-1: 最小段の文字トークンも AA 4.5:1 を満たす値で固定する（床の検算は themeTokens.test.ts R-8）。
    expect(read(light, 'fg-3')).toBe('#5F6F68'); expect(read(dark, 'fg-3')).toBe('#8A9E96');
    for (const t of ['panel-shadow', 'audio-fill', 'audio-border']) { expect(read(dark, t), t).toBeTruthy(); expect(read(light, t), t).toBeTruthy(); }
  });
  it('native の CSS は線に --bg-3 を使わない（線は --border）', () => {
    for (const [file, css] of nativeCss) expect(css, file).not.toMatch(/solid var\(--bg-3\)|border-color:\s*var\(--bg-3\)/);
  });
  it('舞台の背景トークンがある（両テーマ同じ無彩色・F9）', () => {
    expect(read(dark, 'stage-bg')).toBe('#0F1211'); expect(read(light, 'stage-bg')).toBe('#0F1211');
  });
  it('native-studio.css と native-polish.css に直書きの色とグラデーションが無い（F12）', () => {
    for (const file of ['native-studio.css', 'native-polish.css']) {
      const css = readFileSync(join(__dirname, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      expect(css, file).not.toMatch(/#[0-9a-f]{3,8}\b/i);
      expect(css, file).not.toMatch(/linear-gradient|radial-gradient/);
    }
  });
  it('ON トグルは淡色（--accent-soft）で、主操作の塗り（--accent）と区別する（F9）', () => {
    const native = readFileSync(join(__dirname, 'native.css'), 'utf8');
    expect(native).toMatch(/\.native-toggle\[aria-pressed=true\]\s*\{[^}]*background:\s*var\(--accent-soft\)/);
    expect(native).not.toMatch(/\.native-toggle\[aria-pressed=true\]\s*\{[^}]*background:\s*var\(--accent\)\s*;/);
    expect(native).not.toMatch(/--ai-band-from/);
  });
  it('AI 帯は単色（グラデーション無し・F9）', () => {
    const restoration = readFileSync(join(__dirname, 'native-restoration.css'), 'utf8');
    expect(restoration).not.toMatch(/\.native-ai-band[^{]*\{[^}]*linear-gradient/);
    expect(restoration).not.toMatch(/--ai-band-from|--ai-band-to|--ai-band-fg/);
  });
});
