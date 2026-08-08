import { test, expect } from 'vitest';
import { rateToSlider, sliderToRate } from './Inspector';

test('1.0x はスライダー中央付近、両端が 0.1 と 16 に対応する', () => {
  expect(sliderToRate(0)).toBeCloseTo(0.1, 5);
  expect(sliderToRate(1000)).toBeCloseTo(16, 5);
});

test('rateToSlider と sliderToRate は逆変換', () => {
  for (const r of [0.1, 0.25, 0.5, 1, 2, 4, 8, 16]) {
    expect(sliderToRate(rateToSlider(r))).toBeCloseTo(r, 1);
  }
});
