import { useEffect, useMemo, useRef } from 'react';
import { computeWaveformBuckets } from '../../core/waveform';
import { useThemeValue } from '../layout/useThemeValue';

/** canvas 裏バッファ幅の上限（バケット数）。ブラウザの canvas 最大幅と描画負荷を抑える。 */
const MAX_WAVEFORM_BUCKETS = 2400;
// CSS 変数（--wave-rms / --wave-peak）が読めない場合のフォールバック（両テーマ共通の中間ブルーグレー）。
const FALLBACK_RMS_COLOR = 'rgba(96, 118, 150, 0.55)';
const FALLBACK_PEAK_COLOR = 'rgba(96, 118, 150, 0.30)';

interface WaveformProps {
  /** モノラルサンプル。null なら描画しない（デコード前・失敗）。 */
  samples: Float32Array | null;
  /** CSS 上の描画幅（px）。= 原本全長 × pxPerFrame。cut track と一致させる。 */
  width: number;
  /** 描画領域の高さ（px）。 */
  height: number;
  /** canvas に付けるクラス（既定 'tl-waveform'）。クリップ内では 'tl-clip-waveform' を渡す。 */
  className?: string;
  /** バー高さの倍率（音量反映用・既定 1）。0..N。 */
  gain?: number;
}

/**
 * 動画トラック背面の音声波形。samples を width に応じたバケット数へ縮約し、
 * 中央線対称に peak（薄）→ rms（濃）を描く。samples が null/空なら何も描かない。
 * canvas 裏バッファ幅はバケット数（round(width) を 1..MAX_WAVEFORM_BUCKETS にクランプ）、
 * CSS 幅は width（引き伸ばし）。
 */
export function Waveform({ samples, width, height, className = 'tl-waveform', gain = 1 }: WaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // テーマ変更（data-theme）で色を追従させるトリガ。値が変わると下の effect が再描画する。
  const theme = useThemeValue();
  const bucketCount = Math.max(1, Math.min(MAX_WAVEFORM_BUCKETS, Math.round(width)));
  const buckets = useMemo(
    () => (samples === null ? [] : computeWaveformBuckets(samples, bucketCount)),
    [samples, bucketCount],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const dpr = window.devicePixelRatio || 1;
    const cssH = Math.max(1, Math.round(height));
    canvas.width = bucketCount;
    canvas.height = Math.round(cssH * dpr);
    const ctx = canvas.getContext('2d');
    if (ctx === null) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (buckets.length === 0) return;
    // テーマ別の波形色を CSS 変数から読む（data-theme は theme 変数の変化で反映済み）。
    const rootStyle = getComputedStyle(document.documentElement);
    const peakColor = rootStyle.getPropertyValue('--wave-peak').trim() || FALLBACK_PEAK_COLOR;
    const rmsColor = rootStyle.getPropertyValue('--wave-rms').trim() || FALLBACK_RMS_COLOR;
    const h = canvas.height;
    const mid = h / 2;
    ctx.fillStyle = peakColor;
    for (let i = 0; i < buckets.length; i++) {
      const bucket = buckets[i];
      if (bucket === undefined) continue;
      const barH = bucket.peak * h * gain;
      ctx.fillRect(i, mid - barH / 2, 1, barH);
    }
    ctx.fillStyle = rmsColor;
    for (let i = 0; i < buckets.length; i++) {
      const bucket = buckets[i];
      if (bucket === undefined) continue;
      const barH = bucket.rms * h * gain;
      ctx.fillRect(i, mid - barH / 2, 1, barH);
    }
  }, [buckets, bucketCount, height, gain, theme]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ width, height }}
      aria-hidden="true"
    />
  );
}
