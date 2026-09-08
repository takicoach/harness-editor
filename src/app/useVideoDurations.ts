/**
 * useVideoDurations — サブ動画素材の実フレーム長をプローブして保持する。
 *
 * エディタはこれまでサブ動画の実尺を持っていなかった（残課題 #3）。
 * そのため区間長 × 速度がソース残量を超えると、末尾がソース最終フレームで静止する。
 * ここで得た実尺を `videoInsertMaxEnd` に渡してリサイズ 3 経路をクランプする。
 *
 * **実尺不明は「不明のまま」扱う**（推定値を捏造しない）。読めなかった素材は
 * マップに載らず、呼び出し側はクランプしない＝従来挙動になる。
 *
 * 接続枯渇の罠: Chrome は同一オリジン同時 6 接続で、<video> 要素は 1 本 1 接続を
 * 占有する。ライブラリ全件ぶんの <video> を同時に張ると「動画がくるくる・保存が
 * 終わらない」を誘発する（VideoThumb.tsx が 2026-07-24 に踏んだ実害）。よって
 * ここでは DOM へ足さない detached 要素を **1 本ずつ直列に** 使い、読み終えたら
 * 即座に接続を返す。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { assetPathFor, assetUrl } from './panels/materialList';

/** プローブ 1 件あたりの上限。応答しない素材で直列キューを止めないための保険。 */
const PROBE_TIMEOUT_MS = 15000;

/**
 * 尺（秒）→ フレーム。**切り捨て**（素材の外へ 1 フレームもはみ出させない）。
 * 非有限・非正、fps 不正は null（＝実尺不明）。
 */
export function durationToFrames(seconds: number, fps: number): number | null {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  if (!Number.isFinite(fps) || fps <= 0) return null;
  const frames = Math.floor(seconds * fps);
  return frames > 0 ? frames : null;
}

/** まだ実尺の分かっていない URL だけを返す（再プローブを避ける）。 */
export function pendingProbeUrls(urls: string[], known: Record<string, number>): string[] {
  const seen = new Set<string>();
  return urls.filter((u) => {
    if (u === '' || u in known || seen.has(u)) return false;
    seen.add(u);
    return true;
  });
}

/** 1 素材の尺（秒）を返すプローブ。読めなければ null。テストから差し替える。 */
export type VideoDurationProbe = (url: string) => Promise<number | null>;

/**
 * 非表示（DOM 非接続）の <video> で metadata だけ読み、尺（秒）を得る。
 * 読めない素材（コーデック非対応・取得失敗・無応答）は null を返す。
 */
export const probeVideoDurationSeconds: VideoDurationProbe = (url) =>
  new Promise((resolve) => {
    if (typeof document === 'undefined') {
      resolve(null);
      return;
    }
    const el = document.createElement('video');
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finish = (value: number | null): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      el.onloadedmetadata = null;
      el.onerror = null;
      // 進行中の取得を打ち切って接続をすぐ返す（次の 1 件を待たせない）。
      el.removeAttribute('src');
      try {
        el.load();
      } catch {
        // jsdom 等 load() 未実装環境では無視してよい（接続を持たないため）。
      }
      resolve(value);
    };
    timer = setTimeout(() => finish(null), PROBE_TIMEOUT_MS);
    el.preload = 'metadata';
    el.muted = true;
    el.onloadedmetadata = () => finish(Number.isFinite(el.duration) ? el.duration : null);
    el.onerror = () => finish(null);
    el.src = url;
  });

/**
 * サブ動画ライブラリ各ファイルの実フレーム長を返す（file → frames）。
 * 読めなかったファイルはキーごと存在しない＝呼び出し側はクランプしない。
 *
 * キャッシュは URL 単位で持つ。同名差し替えで `assetVersions` の `&v=` が変われば
 * URL も変わり、自動的に再プローブされる（stale な実尺でクランプしない）。
 */
export function useVideoDurations(
  projectId: string,
  videoLibrary: string[],
  fps: number,
  assetVersions?: Record<string, string>,
  probe: VideoDurationProbe = probeVideoDurationSeconds,
): Record<string, number> {
  const [framesByUrl, setFramesByUrl] = useState<Record<string, number>>({});

  // 配列そのものは毎レンダー別 identity になりうるため内容キーで memo する。
  const libraryKey = videoLibrary.join('\u0000');
  const urlByFile = useMemo(() => {
    const out: Record<string, string> = {};
    for (const file of videoLibrary) {
      if (file === '') continue;
      out[file] = assetUrl(projectId, assetPathFor('video', file), assetVersions);
    }
    return out;
    // libraryKey が videoLibrary の内容を代表する。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, libraryKey, assetVersions]);

  // 直列ループ内から「今わかっている分」を読むための鏡（effect の再実行を誘発しない）。
  const knownRef = useRef(framesByUrl);
  knownRef.current = framesByUrl;

  useEffect(() => {
    if (projectId === '') return;
    const pending = pendingProbeUrls(Object.values(urlByFile), knownRef.current);
    if (pending.length === 0) return;
    let cancelled = false;
    void (async () => {
      for (const url of pending) {
        if (cancelled) return;
        const seconds = await probe(url);
        if (cancelled) return;
        const frames = seconds === null ? null : durationToFrames(seconds, fps);
        // 読めなかった素材は載せない（実尺不明のまま＝クランプしない）。
        if (frames === null) continue;
        setFramesByUrl((prev) => (url in prev ? prev : { ...prev, [url]: frames }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, urlByFile, fps, probe]);

  return useMemo(() => {
    const out: Record<string, number> = {};
    for (const [file, url] of Object.entries(urlByFile)) {
      const frames = framesByUrl[url];
      if (frames !== undefined) out[file] = frames;
    }
    return out;
  }, [urlByFile, framesByUrl]);
}
