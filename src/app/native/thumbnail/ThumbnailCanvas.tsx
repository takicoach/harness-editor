import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ScenePlan } from '../../../core/sequence/scenePlan';
import { pageToSequence } from '../../../core/thumbnail/pageToSequence';
import { NativePreviewBridge } from '../../../preview/native/previewBridge';
import { fitStage, type StageReserve } from './canvasMath';
import type { ThumbnailEditor } from './useThumbnailEditor';

/** 既存のプレビュー iframe（サムネ用＝原本の経路）で、案を 1 コマに変換したものを描く。プレビュー＝書き出し。
 *  reserve は右下の小窓（スマホでの見え方）の広さ。キャンバスはその分を空けて置く（重ねない）。 */
export function ThumbnailCanvas({ editor, reserve = null, children }: { editor: ThumbnailEditor; reserve?: StageReserve | null; children?: ReactNode }) {
  const viewport = useRef<HTMLDivElement>(null), host = useRef<HTMLDivElement>(null), bridge = useRef<NativePreviewBridge | null>(null), generation = useRef(0);
  const [error, setError] = useState<string | null>(null), [size, setSize] = useState<{ width: number; height: number } | null>(null), { canvas } = editor.document;
  useEffect(() => {
    const target = host.current;
    if (!target) return;
    const painter = new NativePreviewBridge(target, editor.projectId, undefined, 'thumbnail');
    bridge.current = painter;
    return () => { bridge.current = null; painter.dispose(); };
  }, [editor.projectId]);
  useEffect(() => {
    const box = viewport.current;
    if (!box || typeof ResizeObserver === 'undefined') return;
    // 外形（border-box）だけを見る。余白の付け替えで中身の大きさが変わっても測り直さない。
    const observer = new ResizeObserver(() => {
      const rect = box.getBoundingClientRect();
      setSize(previous => previous && previous.width === rect.width && previous.height === rect.height ? previous : { width: rect.width, height: rect.height });
    });
    observer.observe(box, { box: 'border-box' });
    return () => observer.disconnect();
  }, []);
  const layout = size ? fitStage(size, canvas, reserve) : { scale: .5, padRight: 24, padBottom: 24 };
  const scale = editor.zoom === 'fit' ? layout.scale : editor.zoom;
  useEffect(() => { editor.setScale(scale); }, [scale, editor.setScale]);
  useEffect(() => {
    const painter = bridge.current;
    if (!painter) return;
    const current = ++generation.current;
    let plan: ScenePlan;
    try { plan = new ScenePlan(pageToSequence(editor.previewDocument, editor.pageId, { hiddenLayerIds: editor.hiddenLayerIds, unavailableAssetIds: editor.unavailableAssetIds })); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return; }
    // ドラッグ中は 1 フレームに 1 回だけ描く（古い描画は isCurrent で捨てる）。
    const frame = requestAnimationFrame(() => {
      void painter.render(plan, 0, false, () => current === generation.current).then(geometry => {
        if (current === generation.current) { setError(null); editor.setGeometry(geometry ?? null); }
      }).catch(cause => { if (current === generation.current) setError(cause instanceof Error ? cause.message : String(cause)); });
    });
    return () => cancelAnimationFrame(frame);
  }, [editor.previewDocument, editor.pageId, editor.hiddenLayerIds, editor.unavailableAssetIds, editor.setGeometry]);
  return <div className="native-thumbnail-viewport" ref={viewport} style={{ paddingRight: layout.padRight, paddingBottom: layout.padBottom }}>
    <div className="native-thumbnail-surface" style={{ width: canvas.width * scale, height: canvas.height * scale }}>
      <div className="native-thumbnail-paper" style={{ width: canvas.width, height: canvas.height, transform: `scale(${scale})` }}><div ref={host} /></div>
      {children}
    </div>
    {error && <p className="native-thumbnail-error" role="alert">{error}</p>}
  </div>;
}
