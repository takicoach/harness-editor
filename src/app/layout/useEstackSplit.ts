import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  DEFAULT_TRANSCRIPT_H,
  TRANSCRIPT_HEIGHT_STORAGE_KEY,
  TRANSCRIPT_HEIGHT_CSS_VAR,
  clampTranscriptHeight,
  computeTranscriptHeight,
  parseStoredHeight,
} from '../../core/estackSplit';

/**
 * クランプ基準は estack の実高にする。estack 高は app グリッドの 1fr で決まり
 * --transcript-h には依存しないので帰還ループにならない。取得前のみ window 高へフォールバック。
 */
function containerHeight(): number {
  const rect = document.querySelector('.estack')?.getBoundingClientRect();
  return rect && rect.height > 0 ? rect.height : window.innerHeight;
}

/** 初期の希望高さ: 保存値（生の希望値）をそのまま。無効値／localStorage 不可なら既定。 */
function readInitialHeight(): number {
  try {
    const stored = parseStoredHeight(localStorage.getItem(TRANSCRIPT_HEIGHT_STORAGE_KEY));
    if (stored !== null) return stored;
  } catch {
    // プライベートモード等で localStorage が使えない場合は既定値。
  }
  return DEFAULT_TRANSCRIPT_H;
}

/** 希望高さを estack コンテナでクランプした「適用値」を CSS 変数へ反映する。 */
function applyHeight(desired: number): void {
  const applied = clampTranscriptHeight(desired, containerHeight());
  document.documentElement.style.setProperty(TRANSCRIPT_HEIGHT_CSS_VAR, `${applied}px`);
}

/**
 * 横型レイアウトでの文字起こしストリップ高さの「希望値」state を持ち、適用値（= estack 高 45% で
 * クランプ）を `--transcript-h` へ反映する。`useTimelineHeight` と同型。
 * ハンドルの pointerdown を `onResizeStart`、ダブルクリックを `onReset` で受ける。
 */
export function useEstackSplit(): {
  onResizeStart: (e: React.PointerEvent) => void;
  onReset: () => void;
} {
  // 希望高さ（ユーザーが選んだ値）。適用値は描画/リサイズ時に estack 高でクランプして算出する。
  const [height, setHeight] = useState<number>(readInitialHeight);
  const heightRef = useRef<number>(height);
  const [dragging, setDragging] = useState(false);
  const dragStartRef = useRef<{ startY: number; startHeight: number } | null>(null);

  // 希望値の変化時に適用値を CSS 変数へ反映（ペイント前）。アンマウントでは var をクリアしない。
  useLayoutEffect(() => {
    heightRef.current = height;
    applyHeight(height);
  }, [height]);

  // ウィンドウリサイズ時に最新の希望値で再クランプ。縮めた時に上限を超えたまま残らない。
  useEffect(() => {
    function onResize(): void {
      applyHeight(heightRef.current);
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
      const next = computeTranscriptHeight(s.startHeight, s.startY, ev.clientY, containerHeight());
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
        localStorage.setItem(TRANSCRIPT_HEIGHT_STORAGE_KEY, String(heightRef.current));
      } catch {
        // 保存できなくても致命ではない。
      }
    };
  }, [dragging]);

  const onResizeStart = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    // 開始高さは適用値（クランプ後＝画面表示）にして、見た目とドラッグ開始のズレを防ぐ。
    const startHeight = clampTranscriptHeight(heightRef.current, containerHeight());
    dragStartRef.current = { startY: e.clientY, startHeight };
    setDragging(true);
  }, []);

  const onReset = useCallback(() => {
    setHeight(DEFAULT_TRANSCRIPT_H);
    try {
      localStorage.removeItem(TRANSCRIPT_HEIGHT_STORAGE_KEY);
    } catch {
      // ignore
    }
  }, []);

  return { onResizeStart, onReset };
}
