import { useEffect, useState } from 'react';
import { loadWaveformSamples } from './decodeAudio';

/** 波形サンプル 1 件分の状態。samples が null でも failed=false なら「まだ読み込み中」。 */
export interface WaveformSamplesState {
  samples: Float32Array | null;
  /** true ならデコードが実際に失敗した（音声トラックなし・破損・非対応形式・取得失敗）。 */
  failed: boolean;
}

/**
 * 動画 URL から波形描画用のモノラルサンプルを得るフック。
 * - url が null/空ならサンプルは null・failed=false（未指定は失敗ではない）。
 * - url が変わるたびに再ロードする（古い結果は cancelled で破棄）。
 * - デコード失敗（音声なし・スタブ動画・取得失敗）は例外を握り潰すが、状態としては
 *   failed=true を立てる。タイムラインは波形なしで通常表示を続ける（グレースフル。spec §6）。
 *
 * X-2(b): 従来は Float32Array | null だけを返しており、呼び出し側は
 * samples === null しか見られなかったため「読み込み中」と「失敗」を区別できず、
 * 重い動画を開いた直後に「音声を読み込めません」という**嘘の失敗表示**が出ていた。
 * useAudioClips と同じ { samples, failed } 形にして、失敗のときだけ理由を出せるようにする。
 */
export function useWaveformSamples(url: string | null): WaveformSamplesState {
  const [state, setState] = useState<WaveformSamplesState>({ samples: null, failed: false });
  useEffect(() => {
    setState({ samples: null, failed: false });
    if (url === null || url === '') return;
    let cancelled = false;
    loadWaveformSamples(url)
      .then((s) => {
        if (!cancelled) setState({ samples: s, failed: false });
      })
      .catch((err) => {
        // 例外を握りつぶす（pageerror を出さない）。波形なしで継続しつつ理由は残す。
        if (!cancelled) {
          console.warn('[waveform] decode failed:', err);
          setState({ samples: null, failed: true });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [url]);
  return state;
}
