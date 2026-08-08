import { describe, it, expect } from 'vitest';
import { parseSpeedData, serializeSpeedData } from './speedData';

describe('speedData', () => {
  it('source が null なら既定 1.0', () => {
    expect(parseSpeedData(null).mainSpeed).toBe(1);
  });
  it('MAIN_SPEED を読む', () => {
    expect(parseSpeedData('export const MAIN_SPEED = 0.5;\n').mainSpeed).toBe(0.5);
  });
  it('範囲外はクランプして読む', () => {
    expect(parseSpeedData('export const MAIN_SPEED = 99;\n').mainSpeed).toBe(16);
  });
  it('MAIN_SPEED が無い/不正なら既定 1.0（壊さない）', () => {
    expect(parseSpeedData('export const FOO = 1;\n').mainSpeed).toBe(1);
    expect(parseSpeedData('export const MAIN_SPEED = "x";\n').mainSpeed).toBe(1);
    expect(parseSpeedData('not valid ts <<<').mainSpeed).toBe(1);
  });
  it('1.0 は null を直列化（ファイル不要）', () => {
    expect(serializeSpeedData(1)).toBeNull();
  });
  it('1.0 以外は完全なソースを直列化し、往復で一致', () => {
    const src = serializeSpeedData(0.5);
    expect(src).not.toBeNull();
    expect(src).toContain('MAIN_SPEED');
    expect(parseSpeedData(src).mainSpeed).toBe(0.5);
  });
});

describe('parseSpeedData（SEGMENT_SPEEDS）', () => {
  it('不在は mainSpeed=1・空マップ', () => {
    expect(parseSpeedData(null)).toEqual({ mainSpeed: 1, segmentSpeeds: {} });
  });
  it('MAIN_SPEED のみ（旧形式）も読める', () => {
    expect(parseSpeedData('export const MAIN_SPEED = 0.5;')).toEqual({
      mainSpeed: 0.5,
      segmentSpeeds: {},
    });
  });
  it('MAIN_SPEED と SEGMENT_SPEEDS を読む', () => {
    const src = 'export const MAIN_SPEED = 1;\nexport const SEGMENT_SPEEDS = { 3: 0.5, 7: 2 };';
    expect(parseSpeedData(src)).toEqual({ mainSpeed: 1, segmentSpeeds: { 3: 0.5, 7: 2 } });
  });
  it('SEGMENT_SPEEDS が不正なら空マップ', () => {
    const src = 'export const MAIN_SPEED = 1;\nexport const SEGMENT_SPEEDS = "bad";';
    expect(parseSpeedData(src)).toEqual({ mainSpeed: 1, segmentSpeeds: {} });
  });
});

describe('serializeSpeedData（SEGMENT_SPEEDS）', () => {
  it('mainSpeed=1 かつ個別指定ゼロは null（ファイル不在）', () => {
    expect(serializeSpeedData(1, {})).toBeNull();
    expect(serializeSpeedData(1)).toBeNull();
  });
  it('mainSpeed≠1・個別指定ゼロは MAIN_SPEED と空 SEGMENT_SPEEDS を両方出す', () => {
    const out = serializeSpeedData(0.5, {});
    expect(out).toContain('export const MAIN_SPEED = 0.5;');
    expect(out).toContain('export const SEGMENT_SPEEDS: Record<number, number> = {  };');
  });
  it('mainSpeed=0.5 + 個別ゼロ: MAIN_SPEED と空の SEGMENT_SPEEDS を両方出力', () => {
    const src = serializeSpeedData(0.5, {});
    expect(src).toContain('export const MAIN_SPEED = 0.5;');
    expect(src).toContain('export const SEGMENT_SPEEDS: Record<number, number> = {  };');
  });
  it('mainSpeed=1 + 個別ゼロ: null（ファイル不要・後方互換）', () => {
    expect(serializeSpeedData(1, {})).toBeNull();
  });
  it('個別指定があれば MAIN_SPEED=1 でも両方出す', () => {
    const out = serializeSpeedData(1, { 3: 0.5 });
    expect(out).toContain('export const MAIN_SPEED = 1;');
    expect(out).toContain('export const SEGMENT_SPEEDS');
    expect(out).toContain('3: 0.5');
  });
  it('mainSpeed と一致する冗長エントリのみなら SEGMENT_SPEEDS = {} を出す', () => {
    const out = serializeSpeedData(2, { 3: 2 });
    expect(out).toContain('export const MAIN_SPEED = 2;');
    expect(out).toContain('export const SEGMENT_SPEEDS: Record<number, number> = {  };');
  });
  it('個別指定あり: 両方出力（既存挙動・冗長エントリは落とす）', () => {
    const src = serializeSpeedData(0.5, { 3: 1, 7: 2, 9: 0.5 });
    expect(src).toContain('MAIN_SPEED = 0.5;');
    expect(src).toContain('3: 1');
    expect(src).toContain('7: 2');
    expect(src).not.toContain('9:'); // 冗長（mainSpeed と一致）は落ちる
  });
  it('round-trip', () => {
    const out = serializeSpeedData(1, { 3: 0.5, 7: 2 });
    expect(parseSpeedData(out)).toEqual({ mainSpeed: 1, segmentSpeeds: { 3: 0.5, 7: 2 } });
  });
});
