import { describe, it, expect } from 'vitest';
import { toggleSelection, pruneSelection } from './projectSelection';

describe('toggleSelection', () => {
  it('未選択の ID を足す（順序は選んだ順）', () => {
    expect(toggleSelection(['a'], 'b')).toEqual(['a', 'b']);
  });

  it('選択済みの ID を外す', () => {
    expect(toggleSelection(['a', 'b', 'c'], 'b')).toEqual(['a', 'c']);
  });

  it('元の配列を破壊しない', () => {
    const src = ['a'];
    toggleSelection(src, 'b');
    expect(src).toEqual(['a']);
  });
});

describe('pruneSelection', () => {
  it('一覧から消えたプロジェクトの ID を落とす', () => {
    expect(pruneSelection(['a', 'b'], [{ id: 'a' }])).toEqual(['a']);
  });

  it('落とすものが無ければ同一参照を返す（無駄な再描画を作らない）', () => {
    const ids = ['a', 'b'];
    expect(pruneSelection(ids, [{ id: 'a' }, { id: 'b' }])).toBe(ids);
  });

  it('空の選択は同一参照のまま', () => {
    const ids: string[] = [];
    expect(pruneSelection(ids, [{ id: 'a' }])).toBe(ids);
  });
});
