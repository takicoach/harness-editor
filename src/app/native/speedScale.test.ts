import { describe, expect, it } from 'vitest';
import { formatRate, rateToSlider, sliderToRate, SPEED_MAX, SPEED_MIN, SPEED_PRESETS } from './speedScale';

describe('SPEED_PRESETS', () => {
  it('昇順で、すべて上下限の内側', () => {
    expect([...SPEED_PRESETS]).toEqual([...SPEED_PRESETS].sort((a, b) => a - b));
    for (const preset of SPEED_PRESETS) {
      expect(preset).toBeGreaterThanOrEqual(SPEED_MIN);
      expect(preset).toBeLessThanOrEqual(SPEED_MAX);
    }
  });
  it('等速を必ず含む', () => {
    expect(SPEED_PRESETS).toContain(1);
  });
});

describe('対数スライダー', () => {
  it('両端が上下限に対応する', () => {
    expect(sliderToRate(0)).toBeCloseTo(SPEED_MIN, 10);
    expect(sliderToRate(100)).toBeCloseTo(SPEED_MAX, 10);
  });
  it('中央は 1x（等速）', () => {
    expect(sliderToRate(50)).toBeCloseTo(1, 10);
  });
  it('往復しても値が保たれる', () => {
    for (const preset of SPEED_PRESETS) expect(sliderToRate(rateToSlider(preset))).toBeCloseTo(preset, 0);
  });
  it('スライダーは 0..100 の整数を返し、範囲外の速度はクランプする', () => {
    expect(rateToSlider(0.01)).toBe(0);
    expect(rateToSlider(999)).toBe(100);
    expect(Number.isInteger(rateToSlider(1.5))).toBe(true);
  });
  it('単調増加', () => {
    for (let v = 0; v < 100; v++) expect(sliderToRate(v + 1)).toBeGreaterThan(sliderToRate(v));
  });
  it('非有限な入力は既定値に落とす', () => {
    expect(sliderToRate(NaN)).toBe(1);
    expect(sliderToRate(Infinity)).toBe(1);
    expect(sliderToRate(-Infinity)).toBe(1);
    expect(rateToSlider(NaN)).toBe(50);
    expect(rateToSlider(Infinity)).toBe(50);
    expect(rateToSlider(-Infinity)).toBe(50);
  });
});

describe('formatRate', () => {
  it('等速と小数を同じ書き方で出す', () => {
    expect(formatRate(1)).toBe('1x');
    expect(formatRate(1.5)).toBe('1.5x');
    expect(formatRate(0.25)).toBe('0.25x');
    expect(formatRate(2.004)).toBe('2x');
  });
});
