import { describe, it, expect } from 'vitest';
import { distillWordRules } from './distill';

describe('distillWordRules', () => {
  it('重複する置換を 1 つにまとめる', () => {
    expect(
      distillWordRules([
        { before: 'ゼロ', after: '零' },
        { before: 'ゼロ', after: '零' },
      ]),
    ).toEqual([{ before: 'ゼロ', after: '零' }]);
  });

  it('句読点を含む置換（文の書き換え）は除外する', () => {
    expect(distillWordRules([{ before: 'これは、テスト', after: 'あれは、本番' }])).toEqual([]);
  });

  it('長すぎる置換（既定 12 文字超）は除外する', () => {
    const long = 'あ'.repeat(13);
    expect(distillWordRules([{ before: long, after: 'い' }])).toEqual([]);
  });

  it('通常の語句置換は通す', () => {
    expect(distillWordRules([{ before: '1の肩', after: '壱の型' }])).toEqual([
      { before: '1の肩', after: '壱の型' },
    ]);
  });

  it('after が長すぎる置換（既定 12 文字超）は除外する', () => {
    const longAfter = 'あ'.repeat(13);
    expect(distillWordRules([{ before: 'ゼロ', after: longAfter }])).toEqual([]);
  });

  it('スペースを含む別々の置換を取り違えず両方残す', () => {
    const result = distillWordRules([
      { before: 'a b', after: 'c' },
      { before: 'a', after: 'b c' },
    ]);
    expect(result).toHaveLength(2);
  });
});
