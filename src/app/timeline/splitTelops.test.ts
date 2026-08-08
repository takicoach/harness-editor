import { describe, it, expect } from 'vitest';
import { splitTelops } from './splitTelops';
import type { EditorTelop } from '../../core/types';

/** テスト用の最小 EditorTelop ファクトリ。 */
function makeTelop(id: number, manual?: boolean): EditorTelop {
  return {
    id,
    text: `telop-${id}`,
    originalStart: id * 30,
    originalEnd: id * 30 + 30,
    manual,
  };
}

describe('splitTelops', () => {
  it('空配列は subtitles/manuals ともに空', () => {
    const result = splitTelops([]);
    expect(result.subtitles).toEqual([]);
    expect(result.manuals).toEqual([]);
  });

  it('manual=undefined のテロップは subtitles へ', () => {
    const t = makeTelop(1);
    const result = splitTelops([t]);
    expect(result.subtitles).toHaveLength(1);
    expect(result.manuals).toHaveLength(0);
    expect(result.subtitles[0]).toBe(t);
  });

  it('manual=false のテロップは subtitles へ', () => {
    const t = makeTelop(2, false);
    const result = splitTelops([t]);
    expect(result.subtitles).toHaveLength(1);
    expect(result.manuals).toHaveLength(0);
  });

  it('manual=true のテロップは manuals へ', () => {
    const t = makeTelop(3, true);
    const result = splitTelops([t]);
    expect(result.subtitles).toHaveLength(0);
    expect(result.manuals).toHaveLength(1);
    expect(result.manuals[0]).toBe(t);
  });

  it('混在する配列を正しく振り分ける', () => {
    const t1 = makeTelop(1);          // subtitle
    const t2 = makeTelop(2, true);    // manual
    const t3 = makeTelop(3, false);   // subtitle
    const t4 = makeTelop(4, true);    // manual
    const result = splitTelops([t1, t2, t3, t4]);
    expect(result.subtitles).toEqual([t1, t3]);
    expect(result.manuals).toEqual([t2, t4]);
  });

  it('全件 subtitle の場合 manuals は空', () => {
    const telops = [makeTelop(1), makeTelop(2)];
    const result = splitTelops(telops);
    expect(result.subtitles).toHaveLength(2);
    expect(result.manuals).toHaveLength(0);
  });

  it('全件 manual の場合 subtitles は空', () => {
    const telops = [makeTelop(1, true), makeTelop(2, true)];
    const result = splitTelops(telops);
    expect(result.subtitles).toHaveLength(0);
    expect(result.manuals).toHaveLength(2);
  });
});
