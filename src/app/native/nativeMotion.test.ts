import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** UI 添削 F14: 時間は 4 段のトークン、イージングは 2 種。直書きの .14s のような値を禁止し、動く部品がトークンを使っていることを固定する。 */
const files = readdirSync(__dirname).filter(f => f.endsWith('.css')).map(f => [f, readFileSync(join(__dirname, f), 'utf8')] as const);
const native = files.find(([f]) => f === 'native.css')![1];

describe('native モーション体系', () => {
  it('transition に ms / s の直書きが無い', () => {
    for (const [file, css] of files) {
      const literal = css.match(/transition:[^;]*\b\d+(\.\d+)?m?s\b/g) ?? [];
      expect(literal, file).toEqual([]);
    }
  });
  it('animation の直書き時間は回り続ける輪（再生・保存）だけ', () => {
    // 4 段のトークンは状態の変化に使う 0.26 秒以下の値。回り続ける輪の 1 周はその対象外。
    const loopingRings = ['native-play-ring', 'native-save-orbit'];
    for (const [file, css] of files) {
      const literal = (css.match(/animation:[^;]*\b\d+(\.\d+)?s\b[^;]*/g) ?? []).filter(m => !loopingRings.some(ring => m.includes(ring)));
      expect(literal, file).toEqual([]);
    }
  });
  it('動く部品はトークンを使う', () => {
    for (const pair of [['.native-seg-indicator', '--dur-state'], ['.native-switch-knob', '--ease-spring'], ['.native-toast', '--dur-panel'], ['.native-clip', '--dur-hover'], ['.native-resizer', '--dur-hover']] as const) {
      const [selector, token] = pair;
      const rule = native.match(new RegExp(`^${selector.replace('.', '\\.')}\\s*\\{[^}]*\\}`, 'm'))?.[0] ?? '';
      expect(rule, selector).toContain(token);
    }
  });
});
