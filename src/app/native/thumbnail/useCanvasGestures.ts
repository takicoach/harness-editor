import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import type { ThumbnailLayer } from '../../../core/thumbnail/model';
import { hitTest, movedVisual, rotationFromPointer, scaledLayer, scaleRatio, snapMove, toCanvasPoint, unionBox, widthFromHandle, type LayerBox, type LayerOverride, type Point } from './canvasMath';
import { isEditable } from './layerActions';
import { isCanvasKey } from './useCanvasKeys';
import type { ThumbnailEditor } from './useThumbnailEditor';

type Gesture =
  | { kind: 'move'; pointerId: number; start: Point; layers: ThumbnailLayer[]; moved: boolean; candidate: Map<string, LayerOverride>; box: LayerBox | null; others: LayerBox[] }
  | { kind: 'scale'; pointerId: number; start: Point; layer: ThumbnailLayer; box: LayerBox; candidate: Map<string, LayerOverride> }
  | { kind: 'width'; pointerId: number; start: Point; layer: ThumbnailLayer; box: LayerBox; side: 'left' | 'right'; candidate: Map<string, LayerOverride> }
  | { kind: 'rotate'; pointerId: number; start: Point; layer: ThumbnailLayer; box: LayerBox; candidate: Map<string, LayerOverride> };
export interface CanvasGestures {
  onPointerDown(event: ReactPointerEvent<HTMLDivElement>): void;
  onDoubleClick(event: ReactMouseEvent<HTMLDivElement>): void;
  guides: { x: number[]; y: number[] };
}

/** 1 回のドラッグ＝離した時点で 1 回のコマンド（元に戻す 1 回）。動かしている間は一時表示だけを変える。 */
export function useCanvasGestures(editor: ThumbnailEditor, surface: RefObject<HTMLDivElement>): CanvasGestures {
  const latest = useRef(editor), gesture = useRef<Gesture | null>(null);
  latest.current = editor;
  const [guides, setGuides] = useState<{ x: number[]; y: number[] }>({ x: [], y: [] });
  const pointOf = (event: { clientX: number; clientY: number }): Point => toCanvasPoint(event, surface.current!.getBoundingClientRect(), latest.current.scale);
  useEffect(() => {
    const finish = async (event: PointerEvent, commit: boolean) => {
      const active = gesture.current, current = latest.current;
      if (!active || event.pointerId !== active.pointerId) return;
      gesture.current = null; setGuides({ x: [], y: [] });
      if (!commit || (active.kind === 'move' && !active.moved) || !active.candidate.size) { current.setOverrides(null); return; }
      await current.updateLayers([...active.candidate].map(([layerId, override]) => ({ layerId,
        patch: { ...(override.visual ? { visual: override.visual } : {}), ...(override.content ? { content: override.content } : {}) } })));
      latest.current.setOverrides(null);
    };
    const move = (event: PointerEvent) => {
      const active = gesture.current, current = latest.current;
      if (!active || event.pointerId !== active.pointerId || !surface.current) return;
      const at = pointOf(event), canvas = current.document.canvas;
      if (active.kind === 'move') {
        let dx = at.x - active.start.x, dy = at.y - active.start.y;
        if (!active.moved && Math.hypot(dx, dy) * current.scale < 3) return;
        active.moved = true;
        // 吸着: 閾値は画面で 6px。Alt を押している間は吸い付かない。
        if (!event.altKey && active.box) {
          const snap = snapMove({ ...active.box, cx: active.box.cx + dx, cy: active.box.cy + dy }, active.others, canvas, 6 / current.scale);
          dx += snap.dx; dy += snap.dy;
          setGuides({ x: snap.guidesX, y: snap.guidesY });
        } else setGuides({ x: [], y: [] });
        active.candidate = new Map(active.layers.map(layer => [layer.id, { visual: movedVisual(layer, dx, dy, canvas) }]));
      } else if (active.kind === 'scale') {
        active.candidate = new Map([[active.layer.id, scaledLayer(active.layer, scaleRatio({ x: active.box.cx, y: active.box.cy }, active.start, at))]]);
      } else if (active.kind === 'rotate') {
        const rotation = rotationFromPointer({ x: active.box.cx, y: active.box.cy }, active.start, at, active.layer.visual.rotation, event.shiftKey);
        active.candidate = new Map([[active.layer.id, { visual: { ...active.layer.visual, rotation } }]]);
      } else {
        active.candidate = new Map([[active.layer.id, widthFromHandle(active.layer, active.box, active.start, at, active.side, canvas)]]);
      }
      current.setOverrides(active.candidate);
    };
    const up = (event: PointerEvent) => { void finish(event, true); }, cancel = (event: PointerEvent) => { void finish(event, false); };
    // ドラッグ中（移動・拡縮・回転・幅）のキー。Esc＝取り消し（一時表示を捨てて元の位置へ。コマンドは送らない・選択は外さない）。
    // ほかのキャンバスのキー（矢印・削除・複製・元に戻す…）は離すまで受けない。キー操作のフックより先に受けるため捕捉段で聞く。
    const key = (event: KeyboardEvent) => {
      if (!gesture.current || event.isComposing) return;
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation();
        gesture.current = null; setGuides({ x: [], y: [] }); latest.current.setOverrides(null);
        return;
      }
      if (isCanvasKey(event)) event.preventDefault();
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', cancel); window.addEventListener('keydown', key, true);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', cancel); window.removeEventListener('keydown', key, true); };
  }, []);
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = latest.current;
    if (current.disabled || event.button !== 0 || current.editingText || gesture.current || !surface.current) return;
    // キャンバスを触ったら、直前に押したボタン（モード切替など）の焦点を外す。残すと矢印キーをそのボタンが受けてしまう。
    if (window.document.activeElement instanceof HTMLElement && window.document.activeElement !== window.document.body) window.document.activeElement.blur();
    const at = pointOf(event), handle = (event.target as HTMLElement).closest<HTMLElement>('[data-handle]')?.dataset.handle;
    if (handle) {
      const layer = current.page.layers.find(item => item.id === current.selected[0]), box = layer ? current.boxes.get(layer.id) : undefined;
      if (!layer || !box || current.selected.length !== 1 || !isEditable(layer)) return;
      event.preventDefault();
      if (handle === 'rotate') { gesture.current = { kind: 'rotate', pointerId: event.pointerId, start: at, layer, box, candidate: new Map() }; return; }
      if (handle.startsWith('corner-')) gesture.current = { kind: 'scale', pointerId: event.pointerId, start: at, layer, box, candidate: new Map() };
      else if (handle === 'side-left' || handle === 'side-right') gesture.current = { kind: 'width', pointerId: event.pointerId, start: at, layer, box, side: handle === 'side-left' ? 'left' : 'right', candidate: new Map() };
      return;
    }
    const hit = hitTest(current.page, current.boxes, at);
    if (!hit) { current.select([]); return; }
    if (event.shiftKey) { current.select(current.selected.includes(hit) ? current.selected.filter(id => id !== hit) : [...current.selected, hit]); return; }
    const selection = current.selected.includes(hit) ? current.selected : [hit];
    if (!current.selected.includes(hit)) current.select(selection);
    const layers = current.page.layers.filter(layer => selection.includes(layer.id) && isEditable(layer));
    if (!layers.length) return;
    event.preventDefault();
    const boxes = layers.map(layer => current.boxes.get(layer.id)).filter((box): box is LayerBox => !!box);
    const others = current.page.layers.filter(layer => !selection.includes(layer.id) && !layer.hidden && layer.content.kind !== 'gradient')
      .map(layer => current.boxes.get(layer.id)).filter((box): box is LayerBox => !!box);
    gesture.current = { kind: 'move', pointerId: event.pointerId, start: at, layers, moved: false, candidate: new Map(), box: boxes.length ? unionBox(boxes) : null, others };
  };
  /** 文字のダブルクリックで、その場編集を始める（ロック中は始めない）。 */
  const onDoubleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    const current = latest.current;
    if (current.disabled || current.editingText || !surface.current) return;
    const hit = hitTest(current.page, current.boxes, pointOf(event)), layer = hit ? current.page.layers.find(item => item.id === hit) : undefined;
    if (!layer || layer.content.kind !== 'text' || !isEditable(layer)) return;
    current.select([layer.id]);
    current.setEditingText(layer.id);
  };
  return { onPointerDown, onDoubleClick, guides };
}
