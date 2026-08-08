import { describe, it, expect } from 'vitest';
import {
  resolveMotion,
  sampleMotion,
  motionProgress,
  easeInOutCubic,
  parseMotion,
  formatMotion,
  type Motion,
  type MotionBase,
} from './motion';

const BASE: MotionBase = { x: 0, y: 0, scale: 1, opacity: 1, rotation: 0 };

describe('resolveMotion（プリセット→端点）', () => {
  it('zoomIn は scale が base → base*(1+0.8k)', () => {
    const { from, to } = resolveMotion({ preset: 'zoomIn', intensity: 0.5 }, BASE);
    expect(from.scale).toBe(1);
    expect(to.scale).toBeCloseTo(1.4);
  });
  it('zoomOut は逆向き', () => {
    const { from, to } = resolveMotion({ preset: 'zoomOut', intensity: 1 }, BASE);
    expect(from.scale).toBeCloseTo(1.8);
    expect(to.scale).toBe(1);
  });
  it('panLeft は x が +0.4k → -0.4k（base 中心）', () => {
    const { from, to } = resolveMotion({ preset: 'panLeft', intensity: 1 }, { ...BASE, x: 0.1 });
    expect(from.x).toBeCloseTo(0.5);
    expect(to.x).toBeCloseTo(-0.3);
  });
  it('fadeIn は opacity 0 → base', () => {
    const { from, to } = resolveMotion({ preset: 'fadeIn' }, { ...BASE, opacity: 0.8 });
    expect(from.opacity).toBe(0);
    expect(to.opacity).toBe(0.8);
  });
  it('from/to の明示指定はプリセットを上書きする', () => {
    const m: Motion = { preset: 'zoomIn', intensity: 1, to: { scale: 2, x: 0.5 } };
    const { to } = resolveMotion(m, BASE);
    expect(to.scale).toBe(2);
    expect(to.x).toBe(0.5);
  });
  it('端点はクランプされる（画面外へ吹き飛ばない）', () => {
    const m: Motion = { preset: 'custom', from: { x: -99, scale: 100 }, to: { opacity: 5 } };
    const { from, to } = resolveMotion(m, BASE);
    expect(from.x).toBe(-1.5);
    expect(from.scale).toBe(8);
    expect(to.opacity).toBe(1);
  });
});

describe('sampleMotion（補間）', () => {
  it('progress 0 は from、1 は to、中間はイーズ済み中間値', () => {
    const m: Motion = { preset: 'zoomIn', intensity: 0.5 };
    expect(sampleMotion(m, BASE, 0).scale).toBe(1);
    expect(sampleMotion(m, BASE, 1).scale).toBeCloseTo(1.4);
    expect(sampleMotion(m, BASE, 0.5).scale).toBeCloseTo(1.2); // ease(0.5)=0.5
  });
  it('motion 未指定は base をそのまま返す', () => {
    expect(sampleMotion(undefined, { ...BASE, x: 0.3 }, 0.7)).toEqual({ ...BASE, x: 0.3 });
  });
});

describe('motionProgress / easeInOutCubic', () => {
  it('区間内 0..1・区間外クランプ・縮退区間は 1', () => {
    expect(motionProgress(100, 100, 200)).toBe(0);
    expect(motionProgress(150, 100, 200)).toBe(0.5);
    expect(motionProgress(999, 100, 200)).toBe(1);
    expect(motionProgress(0, 100, 200)).toBe(0);
    expect(motionProgress(100, 100, 100)).toBe(1);
  });
  it('ease は両端 0/1・中央 0.5', () => {
    expect(easeInOutCubic(0)).toBe(0);
    expect(easeInOutCubic(1)).toBe(1);
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5);
  });
});

describe('parseMotion / formatMotion（往復）', () => {
  it('正しい値はそのまま・不正 preset は undefined', () => {
    expect(parseMotion({ preset: 'panRight', intensity: 0.3 }))
      .toEqual({ preset: 'panRight', intensity: 0.3 });
    expect(parseMotion({ preset: 'spin' })).toBeUndefined();
    expect(parseMotion('zoomIn')).toBeUndefined();
    expect(parseMotion(null)).toBeUndefined();
  });
  it('format → 評価 → parse で往復する', () => {
    const m: Motion = { preset: 'custom', from: { x: 0.1, opacity: 0 }, to: { x: -0.2, scale: 1.5 } };
    const text = formatMotion(m);
    // eslint-disable-next-line no-eval
    const roundTripped = parseMotion(eval(`(${text})`));
    expect(roundTripped).toEqual(m);
  });
  it('intensity は 0..1 にクランプして受ける', () => {
    expect(parseMotion({ preset: 'zoomIn', intensity: 9 })).toEqual({ preset: 'zoomIn', intensity: 1 });
  });
});
