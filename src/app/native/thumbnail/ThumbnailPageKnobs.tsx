import { useState } from 'react';
import { hueShiftedLayer } from '../../../core/thumbnail/commands';
import type { GradientSide } from '../../../core/thumbnail/model';
import type { LayerOverride } from './canvasMath';
import { gradientLayerOf } from './layerFactory';
import { ThumbnailNumberKnob } from './ThumbnailKnob';
import type { ThumbnailEditor } from './useThumbnailEditor';

const SIDES: ReadonlyArray<{ side: GradientSide; label: string }> = [{ side: 'left', label: '左' }, { side: 'right', label: '右' }, { side: 'top', label: '上' }, { side: 'bottom', label: '下' }];
const SHADE = { id: 'shade', label: '文字側の暗さ', hint: '写真の片側を暗くして、文字を読みやすくします', min: 0, max: 100, step: 1, unit: '%', initial: 0 };
const HUE = { id: 'hue', label: '色の組み合わせ', hint: '文字・縁・帯・図形の色の色相をまとめて回します（写真と画像は変わりません）', min: -180, max: 180, step: 1, unit: '°', initial: 0 };

/** サムネ全体の欄（常に出す）。暗さはグラデーションの帯のレイヤー 1 枚で持つ。 */
export function ThumbnailPageKnobs({ editor }: { editor: ThumbnailEditor }) {
  const { page } = editor, gradient = page.layers.find(layer => layer.content.kind === 'gradient');
  const shade = gradient?.content.kind === 'gradient' ? gradient.content : null;
  const [side, setSide] = useState<GradientSide>('left'), currentSide = shade?.side ?? side;
  const liveShade = (amount: number) => { if (gradient && shade) editor.setOverrides(new Map([[gradient.id, { content: { ...shade, amount: amount / 100 } }]])); };
  const commitShade = async (amount: number) => {
    if (gradient && shade) {
      if (amount === 0) await editor.execute({ type: 'delete-layers', pageId: page.id, layerIds: [gradient.id] });
      else if (amount / 100 !== shade.amount) await editor.updateLayers([{ layerId: gradient.id, patch: { content: { ...shade, amount: amount / 100 } } }]);
    } else if (amount > 0) {
      // 写真（背景）のすぐ上に入れる。文字や画像素材より後ろ。
      const last = page.layers.reduce((found, layer, index) => layer.content.kind === 'video-frame' || (layer.content.kind === 'image' && layer.content.role === 'photo') ? index : found, -1);
      await editor.execute({ type: 'add-layer', pageId: page.id, layer: gradientLayerOf(editor.newLayerId(), currentSide, amount / 100), index: last + 1 });
    }
    editor.setOverrides(null);
  };
  const chooseSide = (next: GradientSide) => {
    setSide(next);
    if (gradient && shade && shade.side !== next) void editor.updateLayers([{ layerId: gradient.id, patch: { content: { ...shade, side: next } } }]);
  };
  const liveHue = (degrees: number) => {
    const delta = degrees - page.hueShift;
    editor.setOverrides(new Map(page.layers.filter(layer => layer.content.kind === 'text' || layer.content.kind === 'shape')
      .map((layer): [string, LayerOverride] => [layer.id, { content: hueShiftedLayer(layer, delta).content }])));
  };
  const commitHue = async (degrees: number) => {
    if (degrees !== page.hueShift) await editor.execute({ type: 'shift-page-hue', pageId: page.id, degrees });
    editor.setOverrides(null);
  };
  return <section className="native-thumbnail-knob-group" aria-label="サムネ全体"><h3>サムネ全体</h3>
    <ThumbnailNumberKnob spec={SHADE} value={Math.round((shade?.amount ?? 0) * 100)} disabled={editor.disabled} onLive={liveShade} onCommit={value => void commitShade(value)} />
    <div className="native-thumbnail-row" role="radiogroup" aria-label="暗くする側">
      {SIDES.map(item => <button key={item.side} type="button" className="native-toggle" role="radio" aria-checked={currentSide === item.side} aria-pressed={currentSide === item.side}
        disabled={editor.disabled} onClick={() => chooseSide(item.side)}>{item.label}</button>)}
    </div>
    <ThumbnailNumberKnob spec={HUE} value={page.hueShift} disabled={editor.disabled} onLive={liveHue} onCommit={value => void commitHue(value)} />
  </section>;
}
