import { describe, it, expect } from 'vitest';
import { parseRange } from './serveVideo';

describe('parseRange', () => {
  const SIZE = 1000;

  it('Range ヘッダ無しは null', () => {
    expect(parseRange(undefined, SIZE)).toBeNull();
  });
  it('通常の範囲を解釈する', () => {
    expect(parseRange('bytes=0-99', SIZE)).toEqual({ start: 0, end: 99 });
  });
  it('終端省略はファイル末尾まで', () => {
    expect(parseRange('bytes=200-', SIZE)).toEqual({ start: 200, end: 999 });
  });
  it('サフィックス指定は末尾 N バイト', () => {
    expect(parseRange('bytes=-150', SIZE)).toEqual({ start: 850, end: 999 });
  });
  it('終端がサイズ超過なら末尾へクランプする', () => {
    expect(parseRange('bytes=900-5000', SIZE)).toEqual({ start: 900, end: 999 });
  });
  it('開始がサイズ以上は null', () => {
    expect(parseRange('bytes=1000-1100', SIZE)).toBeNull();
  });
  it('start > end は null', () => {
    expect(parseRange('bytes=500-200', SIZE)).toBeNull();
  });
  it('壊れたヘッダは null', () => {
    expect(parseRange('rows=0-9', SIZE)).toBeNull();
  });
});
