import { describe, expect, it } from 'vitest';
import { bgmFadeVolume } from './bgmFade';

describe('bgmFadeVolume', () => {
  it('フェード無しは baseVolume を返す', () => {
    expect(bgmFadeVolume(0, 100, 0.5, 0, 0)).toBe(0.5);
    expect(bgmFadeVolume(50, 100, 0.5, 0, 0)).toBe(0.5);
    expect(bgmFadeVolume(99, 100, 0.5, 0, 0)).toBe(0.5);
  });

  it('フェードインは 0 から baseVolume へ線形に上がる', () => {
    expect(bgmFadeVolume(0, 100, 0.4, 20, 0)).toBeCloseTo(0);
    expect(bgmFadeVolume(10, 100, 0.4, 20, 0)).toBeCloseTo(0.2);
    expect(bgmFadeVolume(20, 100, 0.4, 20, 0)).toBeCloseTo(0.4);
    expect(bgmFadeVolume(50, 100, 0.4, 20, 0)).toBeCloseTo(0.4);
  });

  it('フェードアウトは baseVolume から 0 へ線形に下がる', () => {
    // lastFrame = duration-1 = 99。フェード開始点 = lastFrame-fadeOut = 79。
    // f=79: 満音量（フェード区間の外）
    expect(bgmFadeVolume(79, 100, 0.4, 0, 20)).toBeCloseTo(0.4);
    // f=89: (99-89)/20 = 0.5 → 0.4*0.5 = 0.2
    expect(bgmFadeVolume(89, 100, 0.4, 0, 20)).toBeCloseTo(0.2);
    // 最終描画フレーム f=99 で 0 に達する（Remotion は 0..N-1 を描画）
    expect(bgmFadeVolume(99, 100, 0.4, 0, 20)).toBeCloseTo(0);
  });

  it('フェードアウトは最終描画フレーム(duration-1)で 0 に達する', () => {
    // duration=100, fadeOut=20 → lastFrame=99、f=99 で 0
    expect(bgmFadeVolume(99, 100, 0.4, 0, 20)).toBeCloseTo(0);
    // フェード開始点 lastFrame-fadeOut = 99-20 = 79 で満音量
    expect(bgmFadeVolume(79, 100, 0.4, 0, 20)).toBeCloseTo(0.4);
  });

  it('fadeOut=1 でも最終フレームが無音（ハードカットにならない）', () => {
    // lastFrame=99、f=99 で (99-99)/1 = 0
    expect(bgmFadeVolume(99, 100, 0.5, 0, 1)).toBeCloseTo(0);
    // f=98: (99-98)/1 = 1.0 → 満音量
    expect(bgmFadeVolume(98, 100, 0.5, 0, 1)).toBeCloseTo(0.5);
  });

  it('フェードイン+アウトの合計が区間長を超えても中央で交差し負にならない', () => {
    for (let f = 0; f <= 10; f++) {
      const v = bgmFadeVolume(f, 10, 0.6, 8, 8);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(0.6);
    }
  });

  it('baseVolume を超えない・0 未満にならない', () => {
    expect(bgmFadeVolume(-5, 100, 0.5, 0, 0)).toBeLessThanOrEqual(0.5);
    expect(bgmFadeVolume(0, 100, 0.5, 0, 20)).toBeGreaterThanOrEqual(0);
  });
});
