import { useEffect, useState } from 'react';
import { loadWaveformSamples } from './decodeAudio';

/**
 * 動画 URL から波形描画用のモノラルサンプルを得るフック。
 * - url が null/空ならサンプルは null。
 * - url が変わるたびに再ロードする（古い結果は cancelled で破棄）。
 * - デコード失敗（音声なし・スタブ動画・取得失敗）は握りつぶし null のまま
 *   （タイムラインは波形なしで通常表示＝グレースフル。spec §6）。
 */
export function useWaveformSamples(url: string | null): Float32Array | null {
  const [samples, setSamples] = useState<Float32Array | null>(null);
  useEffect(() => {
    setSamples(null);
    if (url === null || url === '') return;
    let cancelled = false;
    loadWaveformSamples(url)
      .then((s) => {
        if (!cancelled) setSamples(s);
      })
      .catch((err) => {
        // 例外を握りつぶす（pageerror を出さない）。波形なしで継続する。
        if (!cancelled) console.warn('[waveform] decode failed:', err);
      });
    return () => {
      cancelled = true;
    };
  }, [url]);
  return samples;
}
