import { useEffect, useRef, useState } from 'react';

/** サムネ1枚あたりの目安幅（px）。これより細かくは抽出しない（疎なフィルムストリップ）。 */
export const STRIP_THUMB_PX = 80;
/** 同時に抱える最大サムネ枚数（抽出負荷の上限）。 */
const MAX_THUMBS = 24;

export interface FilmstripFrame {
  frame: number;
  url: string;
}

/**
 * videoUrl の動画から疎なサムネ（フィルムストリップ）を生成する。
 * hidden <video> を各フレーム時刻へ seek し canvas で 1 枚ずつ抽出、(videoUrl,frame) でキャッシュ。
 * frames は [0,totalFrames) に count 等間隔。seek 失敗・未対応環境では空のまま（穴は帯/波形が埋める）。
 * 逐次（1 枚ずつ）抽出して同時 seek 負荷を抑える。
 */
export function useFilmstrip(
  videoUrl: string | null,
  totalFrames: number,
  count: number,
): FilmstripFrame[] {
  const [frames, setFrames] = useState<FilmstripFrame[]>([]);
  const cacheRef = useRef<Map<string, string>>(new Map());

  const n = Math.max(0, Math.min(MAX_THUMBS, count));
  const targetFrames =
    n === 0 || totalFrames <= 0
      ? []
      : Array.from({ length: n }, (_, i) => Math.floor((i + 0.5) * (totalFrames / n)));
  const key = `${videoUrl ?? ''}|${totalFrames}|${targetFrames.join(',')}`;

  useEffect(() => {
    if (videoUrl === null || targetFrames.length === 0) {
      setFrames([]);
      return;
    }
    let cancelled = false;
    const cache = cacheRef.current;

    // 既にキャッシュ済みのものは即反映。
    const seeded = targetFrames
      .filter((f) => cache.has(`${videoUrl}@${f}`))
      .map((f) => ({ frame: f, url: cache.get(`${videoUrl}@${f}`)! }));
    setFrames(seeded);

    const missing = targetFrames.filter((f) => !cache.has(`${videoUrl}@${f}`));
    if (missing.length === 0) return;

    const video = document.createElement('video');
    video.muted = true;
    video.crossOrigin = 'anonymous';
    video.preload = 'auto';
    video.src = videoUrl;
    const canvas = document.createElement('canvas');

    const extractNext = (idx: number) => {
      if (cancelled || idx >= missing.length) return;
      const frame = missing[idx]!;
      const time =
        video.duration > 0 ? Math.min(video.duration - 0.01, (frame / totalFrames) * video.duration) : 0;
      const onSeeked = () => {
        video.removeEventListener('seeked', onSeeked);
        if (cancelled) return;
        try {
          const w = 120;
          const h = video.videoHeight > 0 ? Math.round((video.videoHeight / video.videoWidth) * w) : 68;
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.drawImage(video, 0, 0, w, h);
            const url = canvas.toDataURL('image/jpeg', 0.5);
            cache.set(`${videoUrl}@${frame}`, url);
            setFrames((prev) =>
              prev.some((p) => p.frame === frame)
                ? prev
                : [...prev, { frame, url }].sort((a, b) => a.frame - b.frame),
            );
          }
        } catch {
          /* CORS/未対応は無視（穴のまま帯/波形が埋める） */
        }
        extractNext(idx + 1);
      };
      video.addEventListener('seeked', onSeeked);
      video.currentTime = time;
    };

    const onLoaded = () => extractNext(0);
    video.addEventListener('loadeddata', onLoaded);

    return () => {
      cancelled = true;
      video.removeEventListener('loadeddata', onLoaded);
      video.src = '';
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return frames;
}
