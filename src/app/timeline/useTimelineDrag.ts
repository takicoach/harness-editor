import { useCallback, useEffect, useRef, useState } from 'react';
import { xToFrameMapped } from './timelineGeometry';
import type { DisplayMap } from '../../core/timelineDisplayMap';

/** ドラッグ中の状態。drag 中でなければ null。 */
export interface DragState<H> {
  /** ドラッグ対象のつまみ識別子（呼び出し側が定義する型）。 */
  handle: H;
  /** 現在ドラッグ中の原本フレーム（吸着後）。 */
  frame: number;
}

interface UseTimelineDragOptions<H> {
  /** トラックの「原本フレーム 0」に対応する画面 X 座標を返す。pointermove ごとに呼ぶ。 */
  getTrackOriginX: () => number;
  /** 現在のズーム（1 フレームあたりピクセル数）。 */
  pxPerFrame: number;
  /** 表示マップ（per-segment 速度有効時）。省略時は恒等（xToFrame と同一）。 */
  map?: DisplayMap;
  /** ドラッグ移動のたびに呼ばれる。返り値が「確定する原本フレーム」（吸着適用済み）。 */
  onDrag: (handle: H, rawFrame: number) => number;
  /** pointerup / pointercancel で呼ばれる。最終フレームで状態をコミットする。 */
  onCommit: (handle: H, finalFrame: number) => void;
}

interface UseTimelineDragResult<H> {
  /** 現在のドラッグ状態（描画用）。 */
  drag: DragState<H> | null;
  /**
   * つまみの onPointerDown から呼ぶ。ドラッグを開始する。
   * @param originFrame 掴んだつまみの元の原本フレーム。デルタ方式の基準に使う。
   */
  beginDrag: (handle: H, e: React.PointerEvent, originFrame: number) => void;
}

/**
 * タイムラインのつまみドラッグを管理する汎用フック。
 * window へ pointermove / pointerup / pointercancel を貼り、終了時に必ず外す。
 */
export function useTimelineDrag<H>({
  getTrackOriginX,
  pxPerFrame,
  map,
  onDrag,
  onCommit,
}: UseTimelineDragOptions<H>): UseTimelineDragResult<H> {
  const [drag, setDrag] = useState<DragState<H> | null>(null);
  // 最新のコールバック・値を ref で持ち、リスナを貼り直さずに済むようにする。
  const stateRef = useRef({ getTrackOriginX, pxPerFrame, map, onDrag, onCommit });
  stateRef.current = { getTrackOriginX, pxPerFrame, map, onDrag, onCommit };
  // ドラッグ中の最新フレームを ref に保持（pointerup でコミットに使う）。
  const dragRef = useRef<DragState<H> | null>(null);
  dragRef.current = drag;
  // デルタ方式用: 掴んだ時点の「ポインタフレーム」と「つまみの元フレーム」を保持。
  const grabRef = useRef<{ grabPointerFrame: number; originFrame: number } | null>(null);

  const beginDrag = useCallback((handle: H, e: React.PointerEvent, originFrame: number) => {
    e.preventDefault();
    e.stopPropagation();
    const { getTrackOriginX: originX, pxPerFrame: ppf, map: m, onDrag: drag0 } = stateRef.current;
    const grabPointerFrame = xToFrameMapped(e.clientX - originX(), ppf, m);
    grabRef.current = { grabPointerFrame, originFrame };
    // beginDrag 時点では delta === 0 なので rawFrame === originFrame（ジャンプなし）。
    const snapped = drag0(handle, originFrame);
    setDrag({ handle, frame: snapped });
  }, []);

  useEffect(() => {
    if (drag === null) return;

    function onMove(e: PointerEvent): void {
      const { getTrackOriginX: originX, pxPerFrame: ppf, map: m, onDrag: drag0 } = stateRef.current;
      const current = dragRef.current;
      if (current === null) return;
      const grab = grabRef.current;
      if (grab === null) return;
      const currentPointerFrame = xToFrameMapped(e.clientX - originX(), ppf, m);
      const rawFrame = grab.originFrame + (currentPointerFrame - grab.grabPointerFrame);
      const snapped = drag0(current.handle, rawFrame);
      setDrag({ handle: current.handle, frame: snapped });
    }

    function onUp(): void {
      const current = dragRef.current;
      if (current !== null) {
        stateRef.current.onCommit(current.handle, current.frame);
      }
      setDrag(null);
    }

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
    // drag が null↔非null に変わったときだけリスナを貼り直す。
  }, [drag === null]);

  return { drag, beginDrag };
}
