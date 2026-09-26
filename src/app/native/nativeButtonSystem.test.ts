import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * UI 添削 F2 / F3 の回帰固定。native のボタンは class 無しでも「枠・面・hover・active・
 * focus-visible・disabled」を持ち、styles.css の変種クラス（.btn-primary 等）が基底に勝てる。
 * styles.css のボタン共通系統と同じ 4 状態を、CSS テキストから直接固定する（themeTokens.test と同じ流儀）。
 */
const native = readFileSync(join(__dirname, 'native.css'), 'utf8');
const polish = readFileSync(join(__dirname, 'native-polish.css'), 'utf8');
const styles = readFileSync(join(__dirname, '..', 'styles.css'), 'utf8');

describe('native ボタン基底', () => {
  it('基底セレクタは :where で詳細度を 0 にし、変種クラスが勝てる', () => {
    expect(native).toMatch(/:where\(\.native-workspace\) button:where\(:not\(\.color-wheel-disc\)\)\s*\{/);
    expect(native).not.toMatch(/^\.native-workspace button:where/m);
  });
  it('押下・フォーカス・無効の 3 状態を基底が持つ', () => {
    expect(native).toMatch(/:active:not\(:disabled\)\s*\{[^}]*transform:\s*scale\(0\.96\)/);
    expect(native).toMatch(/:where\(\.native-workspace\) button:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--accent\)/);
    expect(native).toMatch(/:where\(\.native-workspace\) button:disabled\s*\{[^}]*cursor:\s*not-allowed/);
  });
  it('基底の transition はモーショントークンを使う（直書き .14s を置かない）', () => {
    expect(native).toMatch(/transform var\(--dur-press\) var\(--ease-settle\)/);
    expect(native).not.toMatch(/\.14s/);
    expect(polish).not.toMatch(/\.14s/);
  });
  it('native-polish.css はボタンの見た目を上書きしない', () => {
    expect(polish).not.toMatch(/\.native-workspace button/);
    expect(polish).not.toMatch(/\.native-export>button/);
    expect(polish).not.toMatch(/\.native-track-delete/);
  });
  it('継承リセットと aria-pressed も :where で詳細度を落とす（変種クラス・.native-toggle が勝つため）', () => {
    expect(native).toMatch(/:where\(\.native-workspace\) button,\s*:where\(\.native-workspace\) input/);
    expect(native).not.toMatch(/^\.native-workspace button\[aria-pressed=true\]/m);
    expect(native).toMatch(/:where\(\.native-workspace\) button\[aria-pressed=true\]/);
  });
  it('styles.css にモーショントークンと tonal 変種がある', () => {
    for (const token of ['--dur-press', '--dur-hover', '--dur-state', '--dur-panel', '--ease-settle', '--ease-spring']) {
      expect(styles).toMatch(new RegExp(`${token}:\\s*[^;]+;`));
    }
    expect(styles).toMatch(/\.btn-tonal\s*\{[^}]*background:\s*var\(--accent-soft\)/);
  });
});
