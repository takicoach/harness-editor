import { boxStyle } from './canvasMath';
import type { ThumbnailEditor } from './useThumbnailEditor';

/** 選択枠と、元の動画が無いコマの印。座標はキャンバス px × 表示倍率。 */
export function ThumbnailSelection({ editor }: { editor: ThumbnailEditor }) {
  const missing = editor.page.layers.filter(layer => layer.content.kind === 'video-frame' && !layer.hidden && editor.unavailableAssetIds.has(layer.content.assetId));
  return <>
    {missing.map(layer => { const box = editor.boxes.get(layer.id); return box
      ? <div key={`missing-${layer.id}`} className="native-thumbnail-missing" style={boxStyle(box, editor.scale)}><span>元の動画が見つかりません</span></div> : null; })}
    {editor.selected.map(id => { const box = editor.boxes.get(id); return box
      ? <div key={id} className="native-thumbnail-outline" data-layer-id={id} style={boxStyle(box, editor.scale)} /> : null; })}
  </>;
}
