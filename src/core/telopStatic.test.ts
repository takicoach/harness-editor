import { describe, it, expect } from 'vitest';
import { telopEntriesState } from './telopStatic';

describe('telopEntriesState（VM 評価なしの三値判定）', () => {
  it('空配列 → empty', () => {
    expect(telopEntriesState('export const telopData = [];')).toBe('empty');
  });

  it('エントリあり → nonempty（実ファイル形: import・型注釈・as const 付き）', () => {
    const src = [
      "import type { TelopSegment } from './telopTypes';",
      "import { FPS } from '../videoConfig';",
      'export const telopData: TelopSegment[] = [',
      '  { id: 1, startFrame: 0, endFrame: 30, text: "こんにちは" },',
      '] as const;',
    ].join('\n');
    expect(telopEntriesState(src)).toBe('nonempty');
  });

  it('telopData が無い → invalid', () => {
    expect(telopEntriesState('export const other = [];')).toBe('invalid');
  });

  it('配列リテラルでない（関数呼び出し等）→ invalid（評価しない）', () => {
    expect(telopEntriesState('export const telopData = buildTelops();')).toBe('invalid');
  });

  it('spread を含む配列 → invalid（件数を静的確定できない）', () => {
    expect(telopEntriesState('export const telopData = [...base];')).toBe('invalid');
  });

  it('構文が壊れていても例外を投げず invalid', () => {
    expect(telopEntriesState('export const telopData = [ {')).toBe('invalid');
  });
});
