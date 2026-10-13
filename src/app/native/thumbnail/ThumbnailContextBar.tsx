import { useRef, useState } from 'react';
import { FONTS, resolveFontByValue } from '../../../core/fonts';
import type { TextAppearance } from '../../../core/sequence/model';
import type { ThumbnailContent, ThumbnailLayer, ThumbnailShape } from '../../../core/thumbnail/model';
import { alignedVisual, type CanvasAlign } from './canvasMath';
import { isEditable } from './layerActions';
import { ThumbnailColorInput } from './ThumbnailKnob';
import { ThumbnailMenuButton } from './ThumbnailMenuButton';
import { fillColor, hasDoubleOutline, resizedFont, STROKE_WIDTHS, withDoubleOutline, withFill, withFontId, withShadow } from './textTools';
import type { ThumbnailEditor } from './useThumbnailEditor';

const BUNDLED = FONTS.filter(font => font.group === 'bundled');
const ALIGN: ReadonlyArray<{ where: CanvasAlign; label: string }> = [
  { where: 'left', label: '左にそろえる' }, { where: 'center', label: '左右の中央' }, { where: 'right', label: '右にそろえる' },
  { where: 'top', label: '上にそろえる' }, { where: 'middle', label: '上下の中央' }, { where: 'bottom', label: '下にそろえる' }];
const IMAGE_TYPES = 'image/png,image/jpeg,image/webp,image/gif,image/avif,image/bmp';

/** 選んだ物の道具（キャンバスの上の帯）。1 つ選んでいるときだけ、種類に合わせた道具を出す。 */
export function ThumbnailContextBar({ editor }: { editor: ThumbnailEditor }) {
  const layer = editor.selected.length === 1 ? editor.page.layers.find(item => item.id === editor.selected[0]) : undefined;
  if (!layer || layer.content.kind === 'gradient') return <div className="native-thumbnail-contextbar" role="toolbar" aria-label="選んだ物の道具">
    <span className="native-thumbnail-note">{layer ? '文字側の暗さは、右の「サムネ全体」で調整します'
      : editor.selected.length > 1 ? `${editor.selected.length} 個を選択中` : 'キャンバスの物をクリックすると、ここに道具が出ます'}</span>
  </div>;
  return <LayerTools key={layer.id} editor={editor} layer={layer} />;
}
function LayerTools({ editor, layer }: { editor: ThumbnailEditor; layer: ThumbnailLayer }) {
  const disabled = editor.disabled || !isEditable(layer), content = editor.overrides.get(layer.id)?.content ?? layer.content;
  const commitContent = (next: ThumbnailContent) => { void editor.updateLayers([{ layerId: layer.id, patch: { content: next } }]).then(() => editor.setOverrides(null)); };
  const liveContent = (next: ThumbnailContent) => editor.setOverrides(new Map([[layer.id, { content: next }]]));
  // 大きさの計測が済むまで（描画が追いつくまで）は押せない。押しても何も起きない無反応を避ける。
  const align = (where: CanvasAlign) => {
    const box = editor.boxes.get(layer.id);
    if (box) void editor.updateLayers([{ layerId: layer.id, patch: { visual: alignedVisual(layer, box, editor.document.canvas, where) } }]);
  };
  const alignMenu = <ThumbnailMenuButton label="配置" disabled={disabled || !editor.boxes.has(layer.id)} items={ALIGN.map(item => ({ label: item.label, run: () => align(item.where) }))} />;
  const more = <button type="button" className="btn-ghost" onClick={editor.openKnobs}>その他</button>;
  if (content.kind === 'text') {
    const appearance = content.appearance, setAppearance = (next: TextAppearance) => commitContent({ ...content, appearance: next });
    return <div className="native-thumbnail-contextbar" role="toolbar" aria-label="文字の道具">
      <select className="native-thumbnail-select" aria-label="書体" disabled={disabled} value={resolveFontByValue(appearance.fontFamily)?.id ?? ''}
        onChange={event => setAppearance(withFontId(appearance, event.target.value))}>
        {BUNDLED.map(font => <option key={font.id} value={font.id}>{font.label}</option>)}
      </select>
      <button type="button" className="btn-ghost native-header-icon" aria-label="文字を小さく" title="文字を小さく" disabled={disabled} onClick={() => setAppearance(resizedFont(appearance, -1))}>−</button>
      <output className="native-thumbnail-size" aria-label="文字の大きさ">{appearance.fontSize}</output>
      <button type="button" className="btn-ghost native-header-icon" aria-label="文字を大きく" title="文字を大きく" disabled={disabled} onClick={() => setAppearance(resizedFont(appearance, 1))}>＋</button>
      <ThumbnailColorInput label="文字の色" value={appearance.color.slice(0, 7)} disabled={disabled}
        onLive={color => liveContent({ ...content, appearance: { ...appearance, color } })} onCommit={color => setAppearance({ ...appearance, color })} />
      <button type="button" className="native-toggle" aria-pressed={hasDoubleOutline(appearance)} disabled={disabled}
        onClick={() => setAppearance(withDoubleOutline(appearance, !hasDoubleOutline(appearance)))}>袋文字</button>
      <button type="button" className="native-toggle" aria-pressed={!!appearance.shadow} disabled={disabled}
        onClick={() => setAppearance(withShadow(appearance, !appearance.shadow))}>影</button>
      {alignMenu}{more}
    </div>;
  }
  if (content.kind === 'image') {
    const flip = () => {
      const { flipX: _flipX, ...rest } = layer.visual;
      void editor.updateLayers([{ layerId: layer.id, patch: { visual: layer.visual.flipX ? rest : { ...layer.visual, flipX: true } } }]);
    };
    return <div className="native-thumbnail-contextbar" role="toolbar" aria-label="画像の道具">
      <ReplaceImage editor={editor} layer={layer} disabled={disabled} />
      <button type="button" className="native-toggle" aria-pressed={!!layer.visual.flipX} disabled={disabled} onClick={flip}>左右反転</button>
      {alignMenu}{more}
    </div>;
  }
  if (content.kind === 'video-frame') return <div className="native-thumbnail-contextbar" role="toolbar" aria-label="写真の道具">{alignMenu}{more}</div>;
  if (content.kind !== 'shape') return null;
  const shape = content.shape, closed = shape.kind === 'rect' || shape.kind === 'ellipse', setShape = (next: ThumbnailShape) => commitContent({ ...content, shape: next });
  const widths = [...new Set([...(closed ? [0] : []), ...STROKE_WIDTHS, shape.strokeWidth])].sort((a, b) => a - b);
  return <div className="native-thumbnail-contextbar" role="toolbar" aria-label="図形の道具">
    {closed && <>
      <ThumbnailColorInput label="塗りの色" value={(fillColor(shape) ?? '#ffffff').slice(0, 7)} disabled={disabled}
        onLive={color => liveContent({ ...content, shape: withFill(shape, color) })} onCommit={color => setShape(withFill(shape, color))} />
      <button type="button" className="native-toggle" aria-pressed={shape.fill !== null} disabled={disabled}
        onClick={() => setShape(withFill(shape, shape.fill ? null : fillColor(shape) ?? '#ffffff'))}>塗り</button>
    </>}
    <ThumbnailColorInput label="線の色" value={shape.color.slice(0, 7)} disabled={disabled}
      onLive={color => liveContent({ ...content, shape: { ...shape, color } })} onCommit={color => setShape({ ...shape, color })} />
    <select className="native-thumbnail-select" aria-label="線の太さ" disabled={disabled} value={String(shape.strokeWidth)}
      onChange={event => setShape({ ...shape, strokeWidth: Number(event.target.value) })}>
      {widths.map(width => <option key={width} value={width}>{width === 0 ? '線なし' : `${width}px`}</option>)}
    </select>
    {alignMenu}
  </div>;
}
/** 画像の置き換え。役割（背景の写真／画像素材）・位置・大きさはそのまま。 */
function ReplaceImage({ editor, layer, disabled }: { editor: ThumbnailEditor; layer: ThumbnailLayer; disabled: boolean }) {
  const input = useRef<HTMLInputElement>(null), [busy, setBusy] = useState(false);
  const take = async (file: File | undefined) => {
    if (!file || layer.content.kind !== 'image') return;
    setBusy(true);
    try {
      const assetId = await editor.session.uploadImage(file);
      if (assetId) await editor.updateLayers([{ layerId: layer.id, patch: { content: { ...layer.content, assetId } } }]);
    } finally { setBusy(false); }
  };
  return <>
    <button type="button" className="btn-ghost" disabled={disabled || busy} onClick={() => input.current?.click()}>置き換え</button>
    <input ref={input} type="file" hidden aria-label="置き換える画像" accept={IMAGE_TYPES} onChange={event => { void take(event.target.files?.[0]); event.target.value = ''; }} />
  </>;
}
