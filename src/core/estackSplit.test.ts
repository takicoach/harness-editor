import { describe, it, expect } from 'vitest';
import {
  MIN_TRANSCRIPT_H,
  DEFAULT_TRANSCRIPT_H,
  maxTranscriptHeight,
  clampTranscriptHeight,
  computeTranscriptHeight,
  parseStoredHeight,
} from './estackSplit';

describe('maxTranscriptHeight', () => {
  it('コンテナの 45%（プレビューを主役に保つ）', () => {
    expect(maxTranscriptHeight(900)).toBe(405);
    expect(maxTranscriptHeight(1000)).toBe(450);
  });
});

describe('clampTranscriptHeight', () => {
  it('中間値はそのまま', () => {
    expect(clampTranscriptHeight(200, 1000)).toBe(200);
  });
  it('下限 96 で止まる', () => {
    expect(clampTranscriptHeight(40, 1000)).toBe(MIN_TRANSCRIPT_H);
  });
  it('上限（コンテナ 45%）で止まる', () => {
    expect(clampTranscriptHeight(900, 1000)).toBe(450);
  });
  it('極小コンテナでは下限が勝つ', () => {
    expect(clampTranscriptHeight(150, 180)).toBe(MIN_TRANSCRIPT_H);
  });
});

describe('computeTranscriptHeight', () => {
  it('上ドラッグ（currentY < startY）で高くなる', () => {
    // 160 + (500 - 400) = 260
    expect(computeTranscriptHeight(160, 500, 400, 2000)).toBe(260);
  });
  it('下ドラッグ（currentY > startY）で低くなる', () => {
    // 220 + (500 - 560) = 160
    expect(computeTranscriptHeight(220, 500, 560, 2000)).toBe(160);
  });
  it('下げすぎても下限 96', () => {
    expect(computeTranscriptHeight(160, 500, 900, 2000)).toBe(MIN_TRANSCRIPT_H);
  });
  it('上げすぎても上限（コンテナ 45%）でクランプ', () => {
    expect(computeTranscriptHeight(160, 500, 0, 1000)).toBe(450);
  });
});

describe('parseStoredHeight', () => {
  it('正常値を数値で返す', () => {
    expect(parseStoredHeight('220')).toBe(220);
  });
  it('null は null', () => {
    expect(parseStoredHeight(null)).toBeNull();
  });
  it('非数は null', () => {
    expect(parseStoredHeight('abc')).toBeNull();
  });
  it('0 と負値は null', () => {
    expect(parseStoredHeight('0')).toBeNull();
    expect(parseStoredHeight('-5')).toBeNull();
  });
});

it('DEFAULT は MIN 以上', () => {
  expect(DEFAULT_TRANSCRIPT_H).toBeGreaterThanOrEqual(MIN_TRANSCRIPT_H);
});
