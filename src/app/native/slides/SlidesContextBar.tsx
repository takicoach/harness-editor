import { FONTS, resolveFontByValue } from '../../../core/fonts';
import type { TextAppearance } from '../../../core/sequence/model';
import type { ThumbnailContent, ThumbnailLayer } from '../../../core/thumbnail/model';
import { alignedVisual, type CanvasAlign } from '../thumbnail/canvasMath';
import { isEditable } from '../thumbnail/layerActions';
import { ThumbnailContextBar } from '../thumbnail/ThumbnailContextBar';
import { ThumbnailColorInput } from '../thumbnail/ThumbnailKnob';
import { ThumbnailMenuButton } from '../thumbnail/ThumbnailMenuButton';
import { resizedFont, withFontId } from '../thumbnail/textTools';
import type { ThumbnailEditor } from '../thumbnail/useThumbnailEditor';
import { hasBullets, TEXT_ALIGNS, toggleBullets } from './textBar';

const BUNDLED = FONTS.filter(font => font.group === 'bundled');
const PLACE: ReadonlyArray<{ where: CanvasAlign; label: string }> = [
  { where: 'left', label: '左にそろえる' }, { where: 'center', label: '左右の中央' }, { where: 'right', label: '右にそろえる' },
  { where: 'top', label: '上にそろえる' }, { where: 'middle', label: '上下の中央' }, { where: 'bottom', label: '下にそろえる' }];
/** 選んだ物の道具の帯。文字はスライド用（書体・− サイズ +・色・箇条書き・揃え・配置）、画像・図形はサムネの帯をそのまま使う。 */
export function SlidesContextBar({ editor }: { editor: ThumbnailEditor }) {
  const layer = editor.selected.length === 1 ? editor.page.layers.find(item => item.id === editor.selected[0]) : undefined;
  if (!layer || layer.content.kind !== 'text') return <ThumbnailContextBar editor={editor} />;
  return <SlidesTextBar key={layer.id} editor={editor} layer={layer} />;
}
function SlidesTextBar({ editor, layer }: { editor: ThumbnailEditor; layer: ThumbnailLayer }) {
  const disabled = editor.disabled || !isEditable(layer), content = editor.overrides.get(layer.id)?.content ?? layer.content;
  if (content.kind !== 'text') return null;
  const commit = (next: ThumbnailContent) => { void editor.updateLayers([{ layerId: layer.id, patch: { content: next } }]).then(() => editor.setOverrides(null)); };
  const appearance = content.appearance, setAppearance = (next: TextAppearance) => commit({ ...content, appearance: next });
  const place = (where: CanvasAlign) => {
    const box = editor.boxes.get(layer.id);
    if (box) void editor.updateLayers([{ layerId: layer.id, patch: { visual: alignedVisual(layer, box, editor.document.canvas, where) } }]);
  };
  return <div className="native-thumbnail-contextbar" role="toolbar" aria-label="文字の道具">
    <select className="native-thumbnail-select" aria-label="書体" disabled={disabled} value={resolveFontByValue(appearance.fontFamily)?.id ?? ''}
      onChange={event => setAppearance(withFontId(appearance, event.target.value))}>
      {BUNDLED.map(font => <option key={font.id} value={font.id}>{font.label}</option>)}
    </select>
    <button type="button" className="btn-ghost native-header-icon" aria-label="文字を小さく" title="文字を小さく" disabled={disabled} onClick={() => setAppearance(resizedFont(appearance, -1))}>−</button>
    <output className="native-thumbnail-size" aria-label="文字の大きさ">{appearance.fontSize}</output>
    <button type="button" className="btn-ghost native-header-icon" aria-label="文字を大きく" title="文字を大きく" disabled={disabled} onClick={() => setAppearance(resizedFont(appearance, 1))}>＋</button>
    <ThumbnailColorInput label="文字の色" value={appearance.color.slice(0, 7)} disabled={disabled}
      onLive={color => editor.setOverrides(new Map([[layer.id, { content: { ...content, appearance: { ...appearance, color } } }]]))} onCommit={color => setAppearance({ ...appearance, color })} />
    <button type="button" className="native-toggle" aria-pressed={hasBullets(content.text)} disabled={disabled} onClick={() => commit({ ...content, text: toggleBullets(content.text) })}>箇条書き</button>
    {TEXT_ALIGNS.map(item => <button key={item.value} type="button" className="native-toggle" aria-pressed={appearance.align === item.value} disabled={disabled}
      onClick={() => setAppearance({ ...appearance, align: item.value })}>{item.label}</button>)}
    <ThumbnailMenuButton label="配置" disabled={disabled || !editor.boxes.has(layer.id)} items={PLACE.map(item => ({ label: item.label, run: () => place(item.where) }))} />
    <button type="button" className="btn-ghost" onClick={editor.openKnobs}>その他</button>
  </div>;
}
