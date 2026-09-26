import {describe, expect, it} from 'vitest';
import {readFileSync, readdirSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {SEQUENCE_COMMAND_TYPES, SEQUENCE_COMMAND_TYPES_NOT_OVER_HTTP, SEQUENCE_HISTORY_COMMAND_TYPES} from '../../core/sequence/commandTypes';
import {SEQUENCE_API_COMMAND_TYPES} from './api';

const sorted = (values: readonly string[]): string[] => [...values].sort();

/**
 * C-1 の再発防止。reducer の union へコマンドを足しても transport の受理集合に入らず、
 * UI のボタンだけが 400 で死ぬ事故（`apply-text-style-all` / `set-text-style-hidden`）を
 * 集合の一致で止める。
 */
describe('/command の受理集合', () => {
  it('受理集合 = SequenceCommand の union − 拒否リスト ＋ 履歴操作（双方向に一致する）', () => {
    const expected = [
      ...SEQUENCE_COMMAND_TYPES.filter(type => !(SEQUENCE_COMMAND_TYPES_NOT_OVER_HTTP as readonly string[]).includes(type)),
      ...SEQUENCE_HISTORY_COMMAND_TYPES,
    ];
    expect(sorted(SEQUENCE_API_COMMAND_TYPES)).toEqual(sorted(expected));
    // 受理集合 ⊆ union ∪ 履歴操作（union に無い綴りが受理集合へ紛れ込まない）
    const known = new Set<string>([...SEQUENCE_COMMAND_TYPES, ...SEQUENCE_HISTORY_COMMAND_TYPES]);
    expect(SEQUENCE_API_COMMAND_TYPES.filter(type => !known.has(type))).toEqual([]);
    // 拒否リストは union の実在メンバーだけ（消えたコマンド名が残らない）
    const union = new Set<string>(SEQUENCE_COMMAND_TYPES);
    expect(SEQUENCE_COMMAND_TYPES_NOT_OVER_HTTP.filter(type => !union.has(type))).toEqual([]);
  });

  it('UI が組み立てる編集操作はすべて受理集合に入っている', () => {
    const root = resolve(import.meta.dirname, '../../app/native');
    const files = readdirSync(root, {recursive: true, encoding: 'utf8'})
      .filter(name => /\.tsx?$/.test(name) && !name.includes('.test.'));
    const union = new Set<string>(SEQUENCE_COMMAND_TYPES);
    const accepted = new Set(SEQUENCE_API_COMMAND_TYPES);
    const used = new Map<string, string>();
    for (const name of files) {
      for (const match of readFileSync(join(root, name), 'utf8').matchAll(/\btype:\s*'([a-z][a-z0-9-]*)'/g)) {
        const type = match[1]!;
        if (union.has(type) && !used.has(type)) used.set(type, name);
      }
    }
    // 走査自体が空振りしていないこと（正規表現が壊れたら恒真になる）
    expect(used.size).toBeGreaterThan(20);
    expect([...used].filter(([type]) => !accepted.has(type))).toEqual([]);
  });
});
