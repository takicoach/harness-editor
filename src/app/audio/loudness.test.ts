import { describe, expect, test } from 'vitest';
import { measureLoudness, normalizedVolume, normalizedVolumeFromSamples, TARGET_RMS, MIN_VOLUME, MAX_VOLUME } from './loudness';

describe('measureLoudness', () => {
  test('無音は rms/peak ともに 0', () => {
    expect(measureLoudness(new Float32Array([0, 0, 0]))).toEqual({ rms: 0, peak: 0 });
  });
  test('一定振幅 0.5 の RMS は 0.5・peak は 0.5', () => {
    const s = new Float32Array([0.5, -0.5, 0.5, -0.5]);
    const { rms, peak } = measureLoudness(s);
    expect(rms).toBeCloseTo(0.5, 6);
    expect(peak).toBeCloseTo(0.5, 6);
  });
  test('空配列は 0', () => {
    expect(measureLoudness(new Float32Array([]))).toEqual({ rms: 0, peak: 0 });
  });
});

describe('normalizedVolume', () => {
  test('大音量（rms>target）は volume を下げる', () => {
    // rms 0.3, target 0.15 → gain 0.5、peak 0.3→peak上限 0.97/0.3=3.2 で gain が勝つ
    const v = normalizedVolume({ rms: 0.3, peak: 0.3 }, 0.15, 0.3);
    expect(v).toBeCloseTo(0.5, 4);
  });
  test('小音量（rms<target）は volume を上げる（上限・ピールでクランプ）', () => {
    // rms 0.05, target 0.15 → gain 3、peak 0.1→peak上限 0.97/0.1=9.7、min(3,9.7)=3 → MAX_VOLUME=1 にクランプ
    const v = normalizedVolume({ rms: 0.05, peak: 0.1 }, 0.15, 0.3);
    expect(v).toBe(MAX_VOLUME);
  });
  test('ピークが高い素材は音割れ防止で MAX 未満に抑える', () => {
    // rms 0.05 → gain 3 だが peak 0.99 → ピーク上限 0.97/0.99≈0.98 が勝ち、MAX(1)未満に収まる
    const v = normalizedVolume({ rms: 0.05, peak: 0.99 }, 0.15, 0.3);
    expect(v).toBeCloseTo(0.97 / 0.99, 4);
  });
  test('ほぼ無音は fallback を返す', () => {
    expect(normalizedVolume({ rms: 0.0005, peak: 0.0005 }, 0.15, 0.3)).toBe(0.3);
  });
  test('結果は [MIN_VOLUME, MAX_VOLUME] に収まる', () => {
    const v = normalizedVolume({ rms: 5, peak: 5 }, 0.15, 0.3); // 極大音量 gain 0.03
    expect(v).toBe(MIN_VOLUME);
  });
});

describe('normalizedVolumeFromSamples', () => {
  test('TARGET_RMS は se=0.15 / bgm=0.08', () => {
    expect(TARGET_RMS.se).toBe(0.15);
    expect(TARGET_RMS.bgm).toBe(0.08);
  });
  test('kind ごとの target で算出（se は bgm より大きめに揃う）', () => {
    const s = new Float32Array([0.2, -0.2, 0.2, -0.2]); // rms 0.2
    const se = normalizedVolumeFromSamples(s, 'se');   // 0.15/0.2 = 0.75
    const bgm = normalizedVolumeFromSamples(s, 'bgm');  // 0.08/0.2 = 0.4
    expect(se).toBeCloseTo(0.75, 4);
    expect(bgm).toBeCloseTo(0.4, 4);
  });
});
