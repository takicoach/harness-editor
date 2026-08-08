/** 種別ごとの目標 RMS（感じる音量の揃え先）。BGM は背景なので控えめ。 */
export const TARGET_RMS = { se: 0.15, bgm: 0.08 } as const;
/** 音割れ防止のピーク上限。 */
export const PEAK_CEILING = 0.97;
/** volume の下限・上限。 */
export const MIN_VOLUME = 0.05;
export const MAX_VOLUME = 1;
/** これ未満の RMS は「ほぼ無音」とみなし正規化しない（ノイズ増幅防止）。 */
export const SILENCE_RMS = 0.001;
/** 正規化できない時の既定音量（挿入既定と一致）。 */
export const FALLBACK_VOLUME = { se: 0.3, bgm: 0.2 } as const;

/** モノラル PCM サンプルから RMS（感じる音量）とピークを測る。 */
export function measureLoudness(samples: Float32Array): { rms: number; peak: number } {
  if (samples.length === 0) return { rms: 0, peak: 0 };
  let sumSq = 0;
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!;
    sumSq += s * s;
    const a = s < 0 ? -s : s;
    if (a > peak) peak = a;
  }
  return { rms: Math.sqrt(sumSq / samples.length), peak };
}

/**
 * 測定結果から「揃えた音量（線形ゲイン 0..1）」を返す。
 * gain = targetRms / rms を基本に、ピークが PEAK_CEILING を超えないよう抑え、[MIN,MAX] にクランプ。
 * ほぼ無音（rms < SILENCE_RMS）は fallback を返す。
 */
export function normalizedVolume(
  loudness: { rms: number; peak: number },
  targetRms: number,
  fallback: number,
): number {
  const { rms, peak } = loudness;
  if (!Number.isFinite(rms) || rms < SILENCE_RMS) return fallback;
  const gain = targetRms / rms;
  const peakLimited = peak > 0 ? PEAK_CEILING / peak : MAX_VOLUME;
  const v = Math.min(gain, peakLimited);
  return Math.min(MAX_VOLUME, Math.max(MIN_VOLUME, v));
}

/** samples と種別から正規化音量を直接得る便利関数（タイムライン／2b の素材ライブラリで使用）。 */
export function normalizedVolumeFromSamples(samples: Float32Array, kind: 'se' | 'bgm'): number {
  return normalizedVolume(measureLoudness(samples), TARGET_RMS[kind], FALLBACK_VOLUME[kind]);
}
