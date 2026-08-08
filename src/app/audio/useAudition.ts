import { useCallback, useEffect, useRef, useState } from 'react';

/** 現在再生中(url)に対し、押された url を再生すべきか(=url)、停止すべきか(=null)を返す。 */
export function nextPlaying(current: string | null, url: string): string | null {
  return current === url ? null : url;
}

/**
 * 単一の HTMLAudioElement を管理する試聴フック。
 * toggle(url): 同じ url なら停止、違えば前を止めて新規再生。volume は実音量(0..1)。
 * 再生終了で自動的に停止状態へ戻る。アンマウントで停止。
 */
export function useAudition(): {
  playingPath: string | null;
  toggle: (url: string, volume?: number) => void;
  stop: () => void;
} {
  const [playingPath, setPlayingPath] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const stop = useCallback(() => {
    audioRef.current?.pause();
    audioRef.current = null;
    setPlayingPath(null);
  }, []);

  const toggle = useCallback((url: string, volume = 1) => {
    audioRef.current?.pause();
    setPlayingPath((current) => {
      const next = nextPlaying(current, url);
      if (next === null) {
        audioRef.current = null;
        return null;
      }
      const audio = new Audio(url);
      audio.volume = Math.max(0, Math.min(1, volume));
      audio.onended = () => setPlayingPath((p) => (p === url ? null : p));
      void audio.play().catch(() => {
        /* アセット取得失敗などは静かに無視 */
      });
      audioRef.current = audio;
      return next;
    });
  }, []);

  useEffect(
    () => () => {
      audioRef.current?.pause();
      audioRef.current = null;
    },
    [],
  );

  return { playingPath, toggle, stop };
}
