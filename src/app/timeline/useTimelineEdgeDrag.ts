import { useRef } from 'react';
import { useTimelineDrag, type DragState } from './useTimelineDrag';
import type { DisplayMap } from '../../core/timelineDisplayMap';

/** body/start/end の3端のみを持つブロック型つまみ（画像・サブ動画・図形トラック共通）。 */
interface EdgeHandle {
  edge: 'start' | 'end' | 'body';
}

/** ドラッグ対象エンティティの原本区間（start/end）。 */
interface EdgeEntity {
  originalStart: number;
  originalEnd: number;
}

interface UseTimelineEdgeDragOptions<Id, H extends EdgeHandle, O> {
  getTrackOriginX: () => number;
  pxPerFrame: number;
  map?: DisplayMap;
  /** 吸着＋ガイド線＋seek 込みの共通スナップ関数（TimelineBody の applySnap）。 */
  applySnap: (rawFrame: number) => number;
  /** ドラッグ対象 ID から現在のエンティティ（originalStart/End）を引く。 */
  findEntity: (id: Id) => EdgeEntity | undefined;
  /** つまみから対象 ID を取り出す。 */
  getId: (handle: H) => Id;
  /** edge='body' の確定移動。 */
  onMove: (id: Id, frame: number) => void;
  /** edge='start' の確定伸縮（clamp 済み start・end を渡す）。 */
  onRetimeStart: (id: Id, start: number, end: number) => void;
  /** edge='end' の確定伸縮（clamp 済み start・end を渡す）。 */
  onRetimeEnd: (id: Id, start: number, end: number) => void;
  /** pointerdown 時の選択反映（session.setTransient(selectX(...)) 等）。 */
  onSelectEntity: (id: Id) => void;
  /** pointerdown 時の矢印キー対象つまみ反映（setSelectedHandle({kind, handle})）。 */
  onBeginSelectedHandle: (handle: H) => void;
  /** commit 後の共通後処理（setSnapHit(null) 等）。 */
  afterCommit?: () => void;
  /** ライブ表示用オーバーライドの組み立て。 */
  buildOverride: (id: Id, start: number, end: number) => O;
  /** 端ドラッグ自動スクロールが足した累積 px（useTimelineDrag へそのまま渡す）。 */
  getAutoScrollDx?: () => number;
}

interface UseTimelineEdgeDragResult<H, O> {
  drag: DragState<H> | null;
  /** ドラッグ開始時点の原本区間（DragTooltip の originFrame 算出用）。 */
  originRef: { current: { start: number; end: number } };
  /** ドラッグ中のライブ表示用オーバーライド（非ドラッグ中は null）。 */
  live: () => O | null;
  /** つまみの onPointerDown から呼ぶ。 */
  onHandleDown: (handle: H, e: React.PointerEvent) => void;
}

/**
 * body/start/end の3端のみを持つブロック型つまみのドラッグ操作を1本にまとめる汎用フック。
 * 画像・サブ動画・図形トラックは処理が完全に同型（edge 種別ごとの clamp 式・onCommit・
 * ライブプレビュー組み立てが同一）なため、この共通フックへ機械的に抽出したもの。
 * ロジックは元の TimelineBody 内の各 *Drag / live* / onHandleDown と同一（機械的抽出・getId 経由の間接化のみ）。
 */
export function useTimelineEdgeDrag<Id, H extends EdgeHandle, O>(
  opts: UseTimelineEdgeDragOptions<Id, H, O>,
): UseTimelineEdgeDragResult<H, O> {
  const originRef = useRef<{ start: number; end: number }>({ start: 0, end: 0 });

  const dragHook = useTimelineDrag<H>({
    getTrackOriginX: opts.getTrackOriginX,
    pxPerFrame: opts.pxPerFrame,
    map: opts.map,
    ...(opts.getAutoScrollDx ? { getAutoScrollDx: opts.getAutoScrollDx } : {}),
    onDrag: (_handle, rawFrame) => opts.applySnap(rawFrame),
    onCommit: (handle, finalFrame) => {
      const origin = originRef.current;
      const id = opts.getId(handle);
      if (handle.edge === 'body') {
        opts.onMove(id, finalFrame);
      } else if (handle.edge === 'start') {
        const clampedStart = Math.min(Math.max(0, finalFrame), origin.end - 1);
        opts.onRetimeStart(id, clampedStart, origin.end);
      } else {
        const clampedEnd = Math.max(origin.start + 1, finalFrame);
        opts.onRetimeEnd(id, origin.start, clampedEnd);
      }
      opts.afterCommit?.();
    },
    // 純クリック（移動ゼロ）は onHandleDown の選択だけで完結させ、コミットしない。
    // 後片付け（吸着ガイドの消去）は commit 時と同じ afterCommit を通す。
    onClick: () => {
      opts.afterCommit?.();
    },
  });

  function live(): O | null {
    if (dragHook.drag === null) return null;
    const { handle, frame } = dragHook.drag;
    const origin = originRef.current;
    const duration = origin.end - origin.start;
    const id = opts.getId(handle);
    if (handle.edge === 'body') {
      const clamped = Math.max(0, frame);
      return opts.buildOverride(id, clamped, clamped + duration);
    }
    if (handle.edge === 'start') {
      const start = Math.min(Math.max(0, frame), origin.end - 1);
      return opts.buildOverride(id, start, origin.end);
    }
    const end = Math.max(origin.start + 1, frame);
    return opts.buildOverride(id, origin.start, end);
  }

  function onHandleDown(handle: H, e: React.PointerEvent): void {
    const id = opts.getId(handle);
    const entity = opts.findEntity(id);
    const originStart = entity?.originalStart ?? 0;
    const originEnd = entity?.originalEnd ?? 0;
    originRef.current = { start: originStart, end: originEnd };
    opts.onSelectEntity(id);
    opts.onBeginSelectedHandle(handle);
    const originFrame = handle.edge === 'end' ? originEnd : originStart;
    dragHook.beginDrag(handle, e, originFrame);
  }

  return { drag: dragHook.drag, originRef, live, onHandleDown };
}
