import { useEffect, useState } from 'react';
import { loadAudioClip, type AudioClip } from './decodeAudio';

/** url 1件分のデコード結果。clip が null でも failed=false なら「まだロード中」の意味。 */
export interface AudioClipState {
  clip: AudioClip | null;
  /** true ならデコードが実際に失敗した（moov atom not found 等）。呼び出し側は理由を表示する。 */
  failed: boolean;
}

/**
 * url 配列に対応する音源クリップ（samples＋durationSec）を返す。
 * 各 url をキャッシュ経由で非同期ロードし、解決ごとに再レンダーする。
 * 戻り値は入力と同順・同長（url=null は { clip: null, failed: false }）。
 * loadAudioClip がキャッシュ/重複排除するので重複デコードはしない。
 *
 * デコード失敗（フィクスチャのスタブ・破損ファイル・非対応コーデック等）は例外を握り潰さず
 * failed=true として返す。呼び出し側（MaterialLibrary 等）はこれを見て「波形なし」の理由を
 * ユーザーに提示すること — 無言で消すと「なぜ波形が出ないのか分からない」故障になる。
 */
export function useAudioClips(urls: Array<string | null>): AudioClipState[] {
  const [map, setMap] = useState<Map<string, AudioClip>>(() => new Map());
  const [failed, setFailed] = useState<Set<string>>(() => new Set());
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
          setFailed((prev) => (prev.has(url) ? new Set([...prev].filter((u) => u !== url)) : prev));
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          console.warn('[audio-clip] decode failed:', url, err);
          setFailed((prev) => (prev.has(url) ? prev : new Set(prev).add(url)));
        });
    }
    return () => {
      cancelled = true;
    };
    // key で urls 変化を表現（map/failed は functional update で読むので依存に含めない）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return urls.map((u) => (u === null ? { clip: null, failed: false } : { clip: map.get(u) ?? null, failed: failed.has(u) }));
}
