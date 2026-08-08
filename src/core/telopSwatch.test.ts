import { describe, it, expect } from 'vitest';
import { swatchSampleText, clampSampleText } from './telopSwatch';

describe('clampSampleText', () => {
  it('12文字以内はそのまま返す', () => {
    expect(clampSampleText('ナイスショット')).toBe('ナイスショット');
  });
  it('12文字超は12文字＋… に切る', () => {
    expect(clampSampleText('あいうえおかきくけこさしすせそ', 12)).toBe('あいうえおかきくけこさし…');
  });
  it('改行は保持する（スタイルの実改行を確認できるように）', () => {
    expect(clampSampleText('一行目\n二行目')).toBe('一行目\n二行目');
  });
  it('行ごとにクランプする（改行は保持）', () => {
    expect(clampSampleText('ゆる素振り\nあいうえおかきくけこさしすせそ', 12)).toBe(
      'ゆる素振り\nあいうえおかきくけこさし…',
    );
  });
  it('各行内の連続空白は半角スペース1つに畳む', () => {
    expect(clampSampleText('ナイス　　ショット')).toBe('ナイス ショット');
  });
  it('前後の空白・空行は除去する', () => {
    expect(clampSampleText('  あ  ')).toBe('あ');
    expect(clampSampleText('\n\nあ\n\n')).toBe('あ');
  });
});

describe('swatchSampleText', () => {
  it('空文字はフォールバック「あア」', () => {
    expect(swatchSampleText('')).toBe('あア');
  });
  it('空白のみもフォールバック', () => {
    expect(swatchSampleText('   ')).toBe('あア');
  });
  it('改行のみもフォールバック', () => {
    expect(swatchSampleText('\n\n')).toBe('あア');
  });
  it('通常文はクランプ結果を返す', () => {
    expect(swatchSampleText('ナイスショット')).toBe('ナイスショット');
  });
  it('改行付きの文は改行を保持して返す', () => {
    expect(swatchSampleText('ゆる素振り\nご紹介いたします')).toBe('ゆる素振り\nご紹介いたします');
  });
});
