import { describe, it, expect } from 'vitest';
import { buildDisplayMap, originalToDisplay, displayToOriginal } from './timelineDisplayMap';

// 原本 0..200。カット区間 [80,100)（20フレーム）。残す区間 id1[0,80) id2[100,200)。
const cutRegions = [{ start: 80, end: 100 }];
const kept = [
  { id: 1, originalStart: 0, originalEnd: 80 },
  { id: 2, originalStart: 100, originalEnd: 200 },
];

describe('buildDisplayMap / identity', () => {
  it('個別速度ゼロ かつ mainSpeed=1 は恒等', () => {
    const m = buildDisplayMap(200, cutRegions, kept, {}, 1);
    expect(m.identity).toBe(true);
    expect(originalToDisplay(150, m)).toBe(150);
    expect(displayToOriginal(150, m)).toBe(150);
    expect(m.displayTotal).toBe(200);
  });
});

describe('buildDisplayMap / 伸縮', () => {
  // id2 を 0.5x（スロー）→ 表示長 100/0.5 = 200。カット帯 [80,100) は 1:1（20）。id1[0,80) は 1:1（80）。
  const m = buildDisplayMap(200, cutRegions, kept, { 2: 0.5 }, 1);
  it('identity=false・表示総長=80+20+200=300', () => {
    expect(m.identity).toBe(false);
    expect(m.displayTotal).toBe(300);
  });
  it('原本→表示（ブロック境界で累積）', () => {
    expect(originalToDisplay(0, m)).toBe(0);
    expect(originalToDisplay(80, m)).toBe(80); // id1 終端
    expect(originalToDisplay(100, m)).toBe(100); // カット帯終端（1:1）
    expect(originalToDisplay(150, m)).toBe(100 + 50 / 0.5); // id2内 50/0.5=100 → 200
    expect(originalToDisplay(200, m)).toBe(300);
  });
  it('表示→原本（逆・往復）', () => {
    expect(displayToOriginal(0, m)).toBe(0);
    expect(displayToOriginal(80, m)).toBe(80);
    expect(displayToOriginal(100, m)).toBe(100);
    expect(displayToOriginal(200, m)).toBe(150);
    expect(displayToOriginal(300, m)).toBe(200);
  });
  it('範囲外は端でクランプ', () => {
    expect(originalToDisplay(-10, m)).toBe(0);
    expect(originalToDisplay(999, m)).toBe(300);
    expect(displayToOriginal(-10, m)).toBe(0);
    expect(displayToOriginal(999, m)).toBe(200);
  });
  it('mainSpeed=2 のみ（個別なし）でも残す区間が一律 0.5 倍幅', () => {
    const m2 = buildDisplayMap(200, cutRegions, kept, {}, 2);
    expect(m2.identity).toBe(false);
    // id1[0,80)→40, カット[80,100)→20, id2[100,200)→50 ⇒ 110
    expect(m2.displayTotal).toBe(110);
    expect(originalToDisplay(80, m2)).toBe(40);
  });
});

describe('buildDisplayMap / identity 経路の範囲外クランプ', () => {
  it('identity マップで範囲外フレームを [0, originalTotal] にクランプする', () => {
    const m = buildDisplayMap(200, cutRegions, kept, {}, 1);
    expect(m.identity).toBe(true);
    expect(originalToDisplay(-5, m)).toBe(0);
    expect(originalToDisplay(999, m)).toBe(200);
    expect(displayToOriginal(-5, m)).toBe(0);
    expect(displayToOriginal(999, m)).toBe(200);
  });
});

describe('buildDisplayMap / 空入力', () => {
  it('空入力 identity=true・displayTotal=originalTotal', () => {
    const m = buildDisplayMap(100, [], [], {}, 1);
    expect(m.identity).toBe(true);
    expect(m.displayTotal).toBe(100);
  });
  it('空入力 非 identity（mainSpeed=2）: displayTotal=0・displayToOriginal=0', () => {
    const m = buildDisplayMap(100, [], [], {}, 2);
    expect(m.identity).toBe(false);
    expect(m.displayTotal).toBe(0);
    expect(displayToOriginal(50, m)).toBe(0);
  });
});
