import { describe, it, expect } from 'vitest';
import {
  DEFAULT_MAIN_LAYOUT,
  isIdentityMainLayout,
  mainLayoutTransform,
  clampLayoutPos,
  clampLayoutScale,
  clampRotation,
} from './mainLayout';

describe('DEFAULT_MAIN_LAYOUT', () => {
  it('全画面・黒・恒等', () => {
    expect(DEFAULT_MAIN_LAYOUT).toEqual({
      position: { x: 0, y: 0 },
      scale: 1,
      background: '#000000',
      rotation: 0,
      flipH: false,
      flipV: false,
    });
    expect(isIdentityMainLayout(DEFAULT_MAIN_LAYOUT)).toBe(true);
  });
});

describe('isIdentityMainLayout', () => {
  it('scale≠1 は非恒等', () => {
    expect(
      isIdentityMainLayout({ position: { x: 0, y: 0 }, scale: 1.2, background: '#000000', rotation: 0, flipH: false, flipV: false }),
    ).toBe(false);
  });
  it('位置ズレは非恒等（背景は不問）', () => {
    expect(
      isIdentityMainLayout({ position: { x: 0.3, y: 0 }, scale: 1, background: '#ffffff', rotation: 0, flipH: false, flipV: false }),
    ).toBe(false);
  });
});

describe('mainLayoutTransform', () => {
  it('InsertVideo と同式（中心原点）', () => {
    expect(
      mainLayoutTransform({ position: { x: 0.5, y: -0.5 }, scale: 1.4, background: '#000000', rotation: 0, flipH: false, flipV: false }),
    ).toBe('translate(25%, -25%) rotate(0deg) scale(1.4, 1.4)');
  });
});

describe('clamp', () => {
  it('pos は -1..1', () => {
    expect(clampLayoutPos(2)).toBe(1);
    expect(clampLayoutPos(-2)).toBe(-1);
  });
  it('scale は 0.1..5', () => {
    expect(clampLayoutScale(9)).toBe(5);
    expect(clampLayoutScale(0)).toBe(0.1);
  });
});

describe('clampRotation', () => {
  it('範囲内はそのまま', () => { expect(clampRotation(45)).toBe(45); expect(clampRotation(-90)).toBe(-90); });
  it('範囲外はクランプ', () => { expect(clampRotation(200)).toBe(180); expect(clampRotation(-200)).toBe(-180); });
  it('非有限は 0', () => { expect(clampRotation(NaN)).toBe(0); expect(clampRotation(Infinity)).toBe(180); });
});

describe('mainLayoutTransform 回転・反転', () => {
  it('回転を rotate() で入れる', () => {
    const t = mainLayoutTransform({ position: { x: 0, y: 0 }, scale: 1, background: '#000', rotation: 30, flipH: false, flipV: false });
    expect(t).toBe('translate(0%, 0%) rotate(30deg) scale(1, 1)');
  });
  it('水平反転は sx を負に', () => {
    const t = mainLayoutTransform({ position: { x: 0, y: 0 }, scale: 2, background: '#000', rotation: 0, flipH: true, flipV: false });
    expect(t).toBe('translate(0%, 0%) rotate(0deg) scale(-2, 2)');
  });
  it('垂直反転は sy を負に', () => {
    const t = mainLayoutTransform({ position: { x: 0.5, y: -0.5 }, scale: 1, background: '#000', rotation: 0, flipH: false, flipV: true });
    expect(t).toBe('translate(25%, -25%) rotate(0deg) scale(1, -1)');
  });
});

describe('isIdentityMainLayout 回転・反転', () => {
  it('回転があれば非恒等', () => {
    expect(isIdentityMainLayout({ ...DEFAULT_MAIN_LAYOUT, rotation: 10 })).toBe(false);
  });
  it('反転があれば非恒等', () => {
    expect(isIdentityMainLayout({ ...DEFAULT_MAIN_LAYOUT, flipH: true })).toBe(false);
    expect(isIdentityMainLayout({ ...DEFAULT_MAIN_LAYOUT, flipV: true })).toBe(false);
  });
  it('全既定は恒等', () => { expect(isIdentityMainLayout(DEFAULT_MAIN_LAYOUT)).toBe(true); });
});
