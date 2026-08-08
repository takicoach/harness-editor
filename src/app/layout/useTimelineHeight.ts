import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  DEFAULT_TIMELINE_H,
  TIMELINE_HEIGHT_STORAGE_KEY,
  clampTimelineHeight,
  computeResizeHeight,
  parseStoredHeight,
} from '../../core/timelineHeight';

/**
 * 初期の希望高さ: 保存値（生の希望値）をそのまま返す。表示用のビューポートクランプは
 * `applyTimelineHeight` が行うため、ここでクランプすると希望値が小さいビューポートで化けて
 * 後で最大化しても戻らなくなる。無効値／localStorage 不可なら既定。
 */
function readInitialHeight(): number {
  try {
    const stored = parseStoredHeight(localStorage.getItem(TIMELINE_HEIGHT_STORAGE_KEY));
    if (stored !== null) return stored;
  } catch {
    // プライベートモード等で localStorage が使えない場合は既定値。
  }
  return DEFAULT_TIMELINE_H;
}

/** 希望高さを現在ビューポートでクランプした「適用値」を CSS 変数へ反映する。 */
function applyTimelineHeight(desired: number): void {
  const applied = clampTimelineHeight(desired, window.innerHeight);
  document.documentElement.style.setProperty('--timeline-h', `${applied}px`);
}

/**
 * タイムライン高さの「希望値」state を持ち、適用値（= 希望値を現在ビューポート 70% でクランプ）を
 * `--timeline-h`（documentElement）へ反映する。ウィンドウリサイズでも再クランプして上限超過を残さない。
 * 希望値はドラッグ終了（またはドラッグ中アンマウント）時に localStorage 永続。
 * ハンドルの pointerdown を `onResizeStart`、ダブルクリックを `onReset` で受ける。
 */
export function useTimelineHeight(): {
  onResizeStart: (e: React.PointerEvent) => void;
  onReset: () => void;
} {
  // 希望高さ（ユーザーが選んだ値）。適用値は描画/リサイズ時にビューポートでクランプして算出する。
  const [height, setHeight] = useState<number>(readInitialHeight);
  const heightRef = useRef<number>(height);
  // ドラッグ中だけ true。この間だけ window リスナを張り、アンマウントで確実に解除する。
  const [dragging, setDragging] = useState(false);
  const dragStartRef = useRef<{ startY: number; startHeight: number } | null>(null);

  // 希望値の変化時に適用値を CSS 変数へ反映（ペイント前）。アンマウントでは var をクリアしない。
  useLayoutEffect(() => {
    heightRef.current = height;
    applyTimelineHeight(height);
  }, [height]);

  // ウィンドウリサイズ時に最新の希望値で再クランプ。縮めた時に 70% 上限を超えたまま残らない。
  // 希望値自体（localStorage）は変えない＝広げ直すと元の高さへ戻る。
  useEffect(() => {
    function onResize(): void {
      applyTimelineHeight(heightRef.current);
    }
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // ドラッグ中だけ pointer リスナを張る。effect クリーンアップで解除＋希望値を永続するため、
  // ドラッグ終了でもドラッグ中アンマウントでも取りこぼし・リーク・unmounted setState が起きない。
  useEffect(() => {
    if (!dragging) return;
    function onMove(ev: PointerEvent): void {
      const s = dragStartRef.current;
      if (s === null) return;
      const next = computeResizeHeight(s.startHeight, s.startY, ev.clientY, window.innerHeight);
      heightRef.current = next;
      setHeight(next);
    }
    function onEnd(): void {
      setDragging(false);
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onEnd);
    window.addEventListener('pointercancel', onEnd);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onEnd);
      window.removeEventListener('pointercancel', onEnd);
      try {
        localStorage.setItem(TIMELINE_HEIGHT_STORAGE_KEY, String(heightRef.current));
      } catch {
        // 保存できなくても致命ではない。
      }
    };
  }, [dragging]);

  const onResizeStart = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    // 開始高さは「適用値（クランプ後＝画面表示）」にする。希望値が現在ビューポートの上限を
    // 超えてクランプ表示されていても、ドラッグ開始が見た目とズレない（小さな下ドラッグが
    // 差分を消費するまで効かない問題を防ぐ）。
    const startHeight = clampTimelineHeight(heightRef.current, window.innerHeight);
    dragStartRef.current = { startY: e.clientY, startHeight };
    setDragging(true);
  }, []);

  const onReset = useCallback(() => {
    setHeight(DEFAULT_TIMELINE_H);
    try {
      localStorage.removeItem(TIMELINE_HEIGHT_STORAGE_KEY);
    } catch {
      // ignore
    }
  }, []);

  return { onResizeStart, onReset };
}
