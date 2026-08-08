// 音声波形の描画用バケット算出（純関数・依存ゼロ・クライアント import 可）。
// RMS バケット化は標準的な DSP 手法で、OpenCut (MIT) も同様の手法を採る（THIRD_PARTY_NOTICES.md）。

/** 波形 1 バケット（描画 1 列ぶん）。peak/rms はいずれも 0..1 に正規化済み。 */
export interface WaveformBucket {
  /** バケット内サンプルの最大絶対振幅（立ち上がりのピーク）。 */
  peak: number;
  /** バケット内サンプルの二乗平均平方根（体感的な音量）。 */
  rms: number;
}

/**
 * モノラル Float32 サンプル列を bucketCount 個のバケットへ縮約する。
 * 各バケットは [floor(b*n/N), floor((b+1)*n/N)) のサンプルから peak/rms を出す。
 * - bucketCount <= 0 なら空配列。
 * - サンプル数 < bucketCount でも bucketCount ぶん返す（空バケットは {0,0}）。
 * - 値は 1 を超えたら 1 にクランプ（描画が振り切れないように）。
 */
export function computeWaveformBuckets(
  samples: Float32Array,
  bucketCount: number,
): WaveformBucket[] {
  if (bucketCount <= 0) return [];
  const n = samples.length;
  const buckets: WaveformBucket[] = [];
  for (let b = 0; b < bucketCount; b++) {
    const startIdx = Math.floor((b * n) / bucketCount);
    const endIdx = Math.floor(((b + 1) * n) / bucketCount);
    let peak = 0;
    let sumSq = 0;
    for (let i = startIdx; i < endIdx; i++) {
      const raw = samples[i] ?? 0;
      const v = Number.isFinite(raw) ? raw : 0;
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
      sumSq += v * v;
    }
    const count = endIdx - startIdx;
    const rms = count > 0 ? Math.sqrt(sumSq / count) : 0;
    buckets.push({ peak: peak > 1 ? 1 : peak, rms: rms > 1 ? 1 : rms });
  }
  return buckets;
}
