import { useEffect, useState } from 'react';
import { getCachedDurationSec, loadWaveformSamples } from './decodeAudio';
import { probeVideoMetadataDurationSec } from './probeVideoDuration';

/**
 * url のソース長（フレーム、fps 換算・四捨五入）を返すフック。
 * Inspector のソース長超過警告（R-1）専用のヒント。
 *
 * 1. まず音声デコード（loadWaveformSamples の副産物、追加コストなし）を試す。
 * 2. 失敗（無音・映像のみで decodeAudioData が例外・取得失敗）したら、
 *    <video> 要素のメタデータ duration へフォールバックする（音声トラック非依存。
 *    本リポジトリの標準サブ動画フィクスチャ cam2.mp4 のような video-only ソースはここで拾う。
 *    レビュー差し戻し: 音声デコードだけだとこの典型ケースで警告が一度も出なかった）。
 * 3. 両方失敗したら null（長さ不明＝警告を出さない）。
 *
 * あくまで UI ヒント。実際の保存時クランプはサーバ側 ffprobe（container 尺）が正で、
 * 音声トラックが無いサブ動画でも独立に安全側で機能する（このフックが null でも保存は守られる）。
 */
export function useSourceDurationFrames(url: string | null, fps: number): number | null {
  const [frames, setFrames] = useState<number | null>(null);
  useEffect(() => {
    setFrames(null);
    if (url === null || url === '') return;
    let cancelled = false;
    const useVideoFallback = () =>
      probeVideoMetadataDurationSec(url).then((sec) => {
        if (!cancelled) setFrames(sec === null ? null : Math.round(sec * fps));
      });
    loadWaveformSamples(url)
      .then(() => {
        if (cancelled) return;
        const sec = getCachedDurationSec(url);
        if (sec !== null) {
          setFrames(Math.round(sec * fps));
          return;
        }
        return useVideoFallback();
      })
      .catch(useVideoFallback);
    return () => {
      cancelled = true;
    };
  }, [url, fps]);
  return frames;
}
