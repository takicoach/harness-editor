import { describe, it, expect } from 'vitest';
import { toOscRgb, oscColorReply, createOscColorResponder } from './oscColorReply';
import { TERMINAL_COLORS } from '../shared/terminalColors';

const LIGHT = () => TERMINAL_COLORS.light;

describe('toOscRgb', () => {
  it('#rrggbb を 16bit の rgb: 表記へ広げる', () => {
    expect(toOscRgb('#ffffff')).toBe('rgb:ffff/ffff/ffff');
    expect(toOscRgb('#1a1a1a')).toBe('rgb:1a1a/1a1a/1a1a');
    expect(toOscRgb('#101418')).toBe('rgb:1010/1414/1818');
  });
});

describe('oscColorReply', () => {
  it('OSC <code> ; rgb:... ST を返す', () => {
    expect(oscColorReply('11', '#ffffff')).toBe('\x1b]11;rgb:ffff/ffff/ffff\x1b\\');
    expect(oscColorReply('10', '#1a1a1a')).toBe('\x1b]10;rgb:1a1a/1a1a/1a1a\x1b\\');
  });
});

describe('createOscColorResponder', () => {
  it('BEL 終端の背景問い合わせに背景色で答える', () => {
    const r = createOscColorResponder(LIGHT);
    expect(r('\x1b]11;?\x07')).toEqual(['\x1b]11;rgb:ffff/ffff/ffff\x1b\\']);
  });

  it('ST 終端の前景問い合わせに前景色で答える', () => {
    const r = createOscColorResponder(LIGHT);
    expect(r('\x1b]10;?\x1b\\')).toEqual(['\x1b]10;rgb:1a1a/1a1a/1a1a\x1b\\']);
  });

  it('1 チャンクに 10 と 11 が並んでいれば 2 件answerする', () => {
    const r = createOscColorResponder(LIGHT);
    expect(r('\x1b]10;?\x07\x1b]11;?\x07')).toHaveLength(2);
  });

  it('チャンク跨ぎで分割されても 1 回だけ答える', () => {
    const r = createOscColorResponder(LIGHT);
    expect(r('前置き\x1b]11')).toEqual([]);
    expect(r(';?\x07あと')).toEqual(['\x1b]11;rgb:ffff/ffff/ffff\x1b\\']);
    expect(r('さらに続き')).toEqual([]);
  });

  it('色の設定コマンド（;rgb:）には答えない', () => {
    const r = createOscColorResponder(LIGHT);
    expect(r('\x1b]11;rgb:0000/0000/0000\x07')).toEqual([]);
  });

  it('同じ問い合わせ列を2回に分けて渡しても二重応答しない', () => {
    const r = createOscColorResponder(LIGHT);
    expect(r('\x1b]11;?\x07')).toHaveLength(1);
    expect(r('ふつうの出力')).toEqual([]);
  });

  it('無関係な長い出力を流しても応答しない', () => {
    const r = createOscColorResponder(LIGHT);
    expect(r('x'.repeat(5000))).toEqual([]);
  });
});
