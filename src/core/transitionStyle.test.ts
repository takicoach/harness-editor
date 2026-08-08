import { describe, it, expect } from 'vitest';
import {
  sceneDurationDefault, overlayColorFor, joinOverlayOpacityAt, edgeOverlayOpacityAt,
  DEFAULT_SCENE_COLOR,
} from './transitionStyle';

describe('sceneDurationDefault', () => {
  it('0.5 秒相当（60fps=30, 30fps=15）', () => {
    expect(sceneDurationDefault(60)).toBe(30);
    expect(sceneDurationDefault(30)).toBe(15);
  });
});

describe('overlayColorFor', () => {
  it('fadeBlack=黒 / fadeWhite=白 / fadeColor=指定色（既定は赤系の DEFAULT）', () => {
    expect(overlayColorFor('fadeBlack')).toBe('#000000');
    expect(overlayColorFor('fadeWhite')).toBe('#FFFFFF');
    expect(overlayColorFor('fadeColor', '#0A84FF')).toBe('#0A84FF');
    expect(overlayColorFor('fadeColor')).toBe(DEFAULT_SCENE_COLOR);
  });
  it('重なる系（Plan 3）はオーバーレイ色を持たない＝null', () => {
    expect(overlayColorFor('crossfade')).toBeNull();
    expect(overlayColorFor('slide')).toBeNull();
    expect(overlayColorFor('wipe')).toBeNull();
  });
});

describe('joinOverlayOpacityAt', () => {
  // join=100, dur=20 → 山は [90,110]。中心 100 で 1、端 90/110 で 0。
  it('つなぎ目中心で 1・窓の外で 0・線形の山', () => {
    expect(joinOverlayOpacityAt(100, 100, 20)).toBe(1);
    expect(joinOverlayOpacityAt(90, 100, 20)).toBe(0);
    expect(joinOverlayOpacityAt(110, 100, 20)).toBe(0);
    expect(joinOverlayOpacityAt(95, 100, 20)).toBeCloseTo(0.5, 5);
    expect(joinOverlayOpacityAt(105, 100, 20)).toBeCloseTo(0.5, 5);
    expect(joinOverlayOpacityAt(50, 100, 20)).toBe(0);  // 窓外
    expect(joinOverlayOpacityAt(200, 100, 20)).toBe(0); // 窓外
  });
  it('durationFrames<=0 は常に 0', () => {
    expect(joinOverlayOpacityAt(100, 100, 0)).toBe(0);
  });
});

describe('edgeOverlayOpacityAt', () => {
  // head: 先頭 dur で 1→0（色から出る）。total=300, dur=20。
  it('頭は先頭で 1・dur 後に 0', () => {
    expect(edgeOverlayOpacityAt(0, 'head', 300, 20)).toBe(1);
    expect(edgeOverlayOpacityAt(20, 'head', 300, 20)).toBe(0);
    expect(edgeOverlayOpacityAt(10, 'head', 300, 20)).toBeCloseTo(0.5, 5);
    expect(edgeOverlayOpacityAt(100, 'head', 300, 20)).toBe(0);
  });
  // tail: 末尾 dur で 0→1（色へ沈む）。
  it('尾は末尾 dur で 0→1', () => {
    expect(edgeOverlayOpacityAt(300, 'tail', 300, 20)).toBe(1);
    expect(edgeOverlayOpacityAt(280, 'tail', 300, 20)).toBe(0);
    expect(edgeOverlayOpacityAt(290, 'tail', 300, 20)).toBeCloseTo(0.5, 5);
    expect(edgeOverlayOpacityAt(100, 'tail', 300, 20)).toBe(0);
  });
});
