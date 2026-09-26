// url の動画メタデータ（duration）を <video> 要素経由で取得する。
// decodeAudioToMono と異なり音声ストリームの有無に依存しない
// （video-only ソースでも `loadedmetadata` が duration を返す）。
// useSourceDurationFrames の音声デコード失敗時フォールバック専用。

/**
 * url の動画の長さ（秒）を <video preload="metadata"> の duration から取得する。
 * 取得できない（404・破損・duration が有限正の値でない）場合は null。例外は投げない。
 * DOM へは挿入しない（メタデータ取得だけなら不要）。
 */
export function probeVideoMetadataDurationSec(url: string): Promise<number | null> {
  return new Promise((resolve) => {
    const el = document.createElement('video');
    el.preload = 'metadata';
    el.muted = true;
    let settled = false;
    const finish = (value: number | null) => {
      if (settled) return;
      settled = true;
      el.removeEventListener('loadedmetadata', onLoaded);
      el.removeEventListener('error', onError);
      el.src = '';
      resolve(value);
    };
    const onLoaded = () => {
      const d = el.duration;
      finish(Number.isFinite(d) && d > 0 ? d : null);
    };
    const onError = () => finish(null);
    el.addEventListener('loadedmetadata', onLoaded);
    el.addEventListener('error', onError);
    el.src = url;
  });
}
