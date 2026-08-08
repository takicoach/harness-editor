import { useEffect, useState } from 'react';
import { loadAudioClip, type AudioClip } from './decodeAudio';

/**
 * url 配列に対応する音源クリップ（samples＋durationSec）を返す。
 * 各 url をキャッシュ経由で非同期ロードし、解決ごとに再レンダーする。
 * 戻り値は入力と同順・同長（未ロード/失敗/url=null は null）。
 * loadAudioClip がキャッシュ/重複排除するので重複デコードはしない。
 */
export function useAudioClips(urls: Array<string | null>): Array<AudioClip | null> {
  const [map, setMap] = useState<Map<string, AudioClip>>(() => new Map());
  // urls の内容が変わった時だけ effect を回す（参照ではなく中身で判定）。
  const key = urls.map((u) => u ?? '').join('|');
  useEffect(() => {
    let cancelled = false;
    for (const url of urls) {
      if (url === null) continue;
      loadAudioClip(url)
        .then((clip) => {
          if (cancelled) return;
          setMap((prev) => (prev.has(url) ? prev : new Map(prev).set(url, clip)));
        })
        .catch(() => {
          /* デコード失敗は null のまま（呼び出し側がフォールバック描画する） */
        });
    }
    return () => {
      cancelled = true;
    };
    // key で urls 変化を表現（map は functional update で読むので依存に含めない）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return urls.map((u) => (u === null ? null : map.get(u) ?? null));
}
