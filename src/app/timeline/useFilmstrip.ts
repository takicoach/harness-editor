import { useEffect, useRef, useState } from 'react';

/** サムネ1枚あたりの目安幅（px）。これより細かくは抽出しない（疎なフィルムストリップ）。 */
export const STRIP_THUMB_PX = 80;
/** 同時に抱える最大サムネ枚数（抽出負荷の上限）。 */
export const MAX_THUMBS = 24;

export interface FilmstripFrame {
  frame: number;
  url: string;
}

export interface FilmstripSourceOptions {
  /** Exact source frame units; fractional frames are retained. Omit for legacy duration-relative sampling. */
  sourceFps: number;
  /** Occurrence/asset identity, independent of a possibly reused URL. */
  ownerKey?: string;
}

/** 指定した原本frameだけを抽出する版。完成順clip表示でも同じ安全な抽出処理を使う。 */
export function useFilmstripFrames(
  videoUrl: string | null,
  totalFrames: number,
  requestedFrames: readonly number[],
  source?: FilmstripSourceOptions,
): FilmstripFrame[] {
  const targetFrames = [...new Set(requestedFrames
    .filter((frame) => Number.isFinite(frame) && Number.isFinite(totalFrames) && totalFrames > 0
      && (!source || Number.isFinite(source.sourceFps) && source.sourceFps > 0 && frame >= 0 && frame < totalFrames))
    .map((frame) => source ? frame : Math.max(0, Math.min(totalFrames - 1, Math.floor(frame)))))]
    .slice(0, MAX_THUMBS)
    .sort((a, b) => a - b);
  return useFilmstripTargets(videoUrl, totalFrames, targetFrames, source);
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
  const n = Math.max(0, Math.min(MAX_THUMBS, count));
  const targetFrames =
    n === 0 || totalFrames <= 0
      ? []
      : Array.from({ length: n }, (_, i) => Math.floor((i + 0.5) * (totalFrames / n)));
  return useFilmstripTargets(videoUrl, totalFrames, targetFrames);
}

function useFilmstripTargets(
  videoUrl: string | null,
  totalFrames: number,
  targetFrames: readonly number[],
  source?: FilmstripSourceOptions,
): FilmstripFrame[] {
  const [loaded, setLoaded] = useState<{key:string;frames:FilmstripFrame[]}|null>(null);
  const cacheRef = useRef<{owner:string;frames:Map<number,string>}>({owner:'',frames:new Map()});
  const owner = JSON.stringify([videoUrl,totalFrames,source?.sourceFps,source?.ownerKey]);
  const key = JSON.stringify([owner,targetFrames]);

  useEffect(() => {
    if (videoUrl === null || targetFrames.length === 0) {
      cacheRef.current={owner,frames:new Map()};
      setLoaded({key,frames:[]});
      return;
    }
    let cancelled = false;
    if(cacheRef.current.owner!==owner)cacheRef.current={owner,frames:new Map()};
    const cache=cacheRef.current.frames;
    // Keep only this bounded visible request, not every visited source frame.
    for(const frame of cache.keys())if(!targetFrames.includes(frame))cache.delete(frame);

    // 既にキャッシュ済みのものは即反映。
    const seeded = targetFrames
      .filter((f) => cache.has(f))
      .map((f) => ({ frame: f, url: cache.get(f)! }));
    setLoaded({key,frames:seeded});

    const missing = targetFrames.filter((f) => !cache.has(f));
    if (missing.length === 0) return;

    const video = document.createElement('video');
    video.muted = true;
    video.crossOrigin = 'anonymous';
    video.preload = 'auto';
    const canvas = document.createElement('canvas');
    let seekListener:(()=>void)|null=null;
    let timer:ReturnType<typeof setTimeout>|undefined;
    const stop=()=>{
      cancelled=true;clearTimeout(timer);
      if(seekListener)video.removeEventListener('seeked',seekListener);
      video.removeEventListener('loadeddata',onLoaded);
      video.removeEventListener('error',stop);
      video.removeAttribute('src');
      // Abort the media resource selection/download, including an unfinished seek.
      video.load();
    };

    const extractNext = (idx: number) => {
      if (cancelled) return;
      if (idx >= missing.length){stop();return;}
      const frame = missing[idx]!;
      if(!Number.isFinite(video.duration)||video.duration<=0){stop();return;}
      const time = source ? frame/source.sourceFps : Math.max(0,Math.min(video.duration - 0.01, (frame / totalFrames) * video.duration));
      // Exact mode does not invent an EOF frame when metadata disagrees with the resource.
      if(time<0||time>=video.duration){extractNext(idx+1);return;}
      const onSeeked = () => {
        video.removeEventListener('seeked', onSeeked);
        seekListener=null;clearTimeout(timer);
        if (cancelled) return;
        try {
          const w = 120;
          const h = video.videoHeight > 0 && video.videoWidth > 0
            ? Math.max(1,Math.min(240,Math.round((video.videoHeight / video.videoWidth) * w))) : 68;
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.drawImage(video, 0, 0, w, h);
            const url = canvas.toDataURL('image/jpeg', 0.5);
            cache.set(frame,url);
            setLoaded({key,frames:targetFrames.filter(f=>cache.has(f)).map(f=>({frame:f,url:cache.get(f)!}))});
          }
        } catch {
          /* CORS/未対応は無視（穴のまま帯/波形が埋める） */
        }
        extractNext(idx + 1);
      };
      seekListener=onSeeked;
      timer=setTimeout(stop,8000);
      if(video.currentTime===time&&video.readyState>=2){onSeeked();return;}
      video.addEventListener('seeked', onSeeked);
      try{video.currentTime = time;}catch{stop();}
    };

    const onLoaded = () => {video.removeEventListener('loadeddata',onLoaded);clearTimeout(timer);extractNext(0);};
    video.addEventListener('loadeddata', onLoaded);
    video.addEventListener('error',stop);
    timer=setTimeout(stop,8000);
    video.src=videoUrl;

    return () => {
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Effects run after render: never expose the preceding URL/owner/request for that render.
  return loaded?.key===key?loaded.frames:[];
}
