import { describe, it, expect } from 'vitest';
import { promoteWordRules, unlearnWord, partitionByConflict } from './promote';
import { emptyTypoDict } from './typoDict';
import type { StoreSnapshot } from './types';

function emptyStore(): StoreSnapshot {
  return { typoDict: emptyTypoDict(), typoDictMeta: { observations: {}, lastSeen: {} } };
}

describe('promoteWordRules', () => {
  it('新しい語句ルールを replace へ追加し観測回数 1 にする', () => {
    const next = promoteWordRules(emptyStore(), [{ before: 'ゼロ式', after: '零式' }], 'drill-01');
    expect(next.typoDict.replace).toEqual({ ゼロ式: '零式' });
    expect(next.typoDictMeta.observations).toEqual({ ゼロ式: 1 });
    expect(next.typoDictMeta.lastSeen).toEqual({ ゼロ式: 'drill-01' });
  });

  it('既存ルールの再観測は観測回数を加算する', () => {
    const once = promoteWordRules(emptyStore(), [{ before: 'ゼロ式', after: '零式' }], 'drill-01');
    const twice = promoteWordRules(once, [{ before: 'ゼロ式', after: '零式' }], 'drill-02');
    expect(twice.typoDictMeta.observations).toEqual({ ゼロ式: 2 });
    expect(twice.typoDictMeta.lastSeen).toEqual({ ゼロ式: 'drill-02' });
  });

  it('入力を破壊しない（新しいスナップショットを返す）', () => {
    const store = emptyStore();
    promoteWordRules(store, [{ before: 'a', after: 'b' }], 'v1');
    expect(store.typoDict.replace).toEqual({});
  });
});

describe('unlearnWord', () => {
  it('replace とメタから語句を取り除く', () => {
    const store = promoteWordRules(emptyStore(), [{ before: 'ゼロ式', after: '零式' }], 'v1');
    const next = unlearnWord(store, 'ゼロ式');
    expect(next.typoDict.replace).toEqual({});
    expect(next.typoDictMeta.observations).toEqual({});
    expect(next.typoDictMeta.lastSeen).toEqual({});
  });
});

describe('partitionByConflict', () => {
  it('競合なしのルールはすべて promotable に入る', () => {
    const store = emptyStore();
    const rules = [
      { before: 'ゼロ式', after: '零式' },
      { before: '1の肩', after: '壱の型' },
    ];
    const { promotable, conflicts } = partitionByConflict(store, rules);
    expect(promotable).toEqual(rules);
    expect(conflicts).toEqual([]);
  });

  it('既存ストアに別の after で登録済みのルールは conflicts に入る', () => {
    const store = promoteWordRules(emptyStore(), [{ before: 'ゼロ式', after: '零式' }], 'v1');
    const rules = [{ before: 'ゼロ式', after: 'ZERO式' }];
    const { promotable, conflicts } = partitionByConflict(store, rules);
    expect(promotable).toEqual([]);
    expect(conflicts).toEqual([{ before: 'ゼロ式', after: 'ZERO式' }]);
  });

  it('既存ストアと同じ after のルールは promotable（再観測、競合ではない）', () => {
    const store = promoteWordRules(emptyStore(), [{ before: 'ゼロ式', after: '零式' }], 'v1');
    const rules = [{ before: 'ゼロ式', after: '零式' }];
    const { promotable, conflicts } = partitionByConflict(store, rules);
    expect(promotable).toEqual([{ before: 'ゼロ式', after: '零式' }]);
    expect(conflicts).toEqual([]);
  });

  it('同一バッチ内で同じ before に別の after → 先勝ち、後者は conflicts', () => {
    const store = emptyStore();
    const rules = [
      { before: 'ゼロ式', after: '零式' },
      { before: 'ゼロ式', after: 'ZERO式' },
    ];
    const { promotable, conflicts } = partitionByConflict(store, rules);
    expect(promotable).toEqual([{ before: 'ゼロ式', after: '零式' }]);
    expect(conflicts).toEqual([{ before: 'ゼロ式', after: 'ZERO式' }]);
  });
});
