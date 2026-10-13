import { describe, expect, it } from 'vitest';
import { extractJson, normalizePages } from './pasteJson';

describe('貼り付けた回答から JSON を取り出す', () => {
  it('コードの囲みや前置きの文を外して読む', () => {
    expect(extractJson('はい、どうぞ。\n```json\n{"schema":"x","pages":[]}\n```')).toEqual({ ok: true, value: { schema: 'x', pages: [] } });
    expect(extractJson('[{"key":"s1"}]')).toEqual({ ok: true, value: [{ key: 's1' }] });
  });
  it('読めないときは理由を返す', () => {
    expect(extractJson('ありません')).toMatchObject({ ok: false, message: expect.stringContaining('JSON が見つかりません') });
    expect(extractJson('{"schema": }')).toMatchObject({ ok: false, message: expect.stringContaining('JSON として読めません') });
  });
  it('本文は配列か {pages: [...]} を受ける', () => {
    expect(normalizePages({ pages: [1, 2] })).toEqual([1, 2]);
    expect(normalizePages([3])).toEqual([3]);
    expect(normalizePages({ other: 1 })).toEqual({ other: 1 });
  });
});
