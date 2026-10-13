import type { ReactNode } from 'react';
import { Icon } from '../../Icon';
import { knobGroupFor, type KnobValue } from '../thumbnail/knobs';
import { ThumbnailColorKnob, ThumbnailNumberKnob } from '../thumbnail/ThumbnailKnob';
import type { ThumbnailEditor } from '../thumbnail/useThumbnailEditor';

/** 文字の大きさは道具の帯の − ＋ で変える（つまみの初期値はサムネ用の大きさなので出さない）。 */
const HIDDEN_KNOBS = new Set(['font-size']);
/** 右のつまみ（常設・畳める）。上に「選択中」の札と選んだ物のスライダー、下にページの情報（収まり・元の台本・置き換え案）。 */
export function SlidesKnobsPanel({ editor, open, onOpen, children }: { editor: ThumbnailEditor; open: boolean; onOpen(open: boolean): void; children?: ReactNode }) {
  const layer = editor.selected.length === 1 ? editor.page.layers.find(item => item.id === editor.selected[0]) : undefined;
  if (!open) return <aside className="native-thumbnail-knobs" aria-label="つまみ">
    <button type="button" className="btn-ghost native-header-icon" aria-label="つまみを開く" title="つまみを開く" onClick={() => onOpen(true)}><Icon name="sliders" /></button></aside>;
  const base: KnobValue | null = layer ? { visual: layer.visual, content: layer.content } : null;
  const override = layer ? editor.overrides.get(layer.id) : undefined;
  const shown: KnobValue | null = base ? { visual: override?.visual ?? base.visual, content: override?.content ?? base.content } : null;
  const live = (next: KnobValue) => { if (layer) editor.setOverrides(new Map([[layer.id, next]])); };
  const commit = async (next: KnobValue) => {
    if (!layer || !base) return;
    if (JSON.stringify(next) !== JSON.stringify(base)) await editor.updateLayers([{ layerId: layer.id, patch: { visual: next.visual, content: next.content } }]);
    editor.setOverrides(null);
  };
  const group = layer ? knobGroupFor(layer) : null, knobs = group?.knobs.filter(knob => !HIDDEN_KNOBS.has(knob.id)) ?? [], disabled = editor.disabled || !!layer?.locked;
  return <aside className="native-thumbnail-knobs" aria-label="つまみ">
    <header className="native-thumbnail-knobs-head"><strong>つまみ</strong>
      <button type="button" className="btn-ghost native-header-icon" aria-label="つまみを畳む" title="つまみを畳む" onClick={() => onOpen(false)}><Icon name="chevron-right" /></button></header>
    <p className="native-thumbnail-chip">{layer ? `選択中: ${layer.name}${layer.locked ? '（ロック中）' : ''}` : editor.selected.length > 1 ? `${editor.selected.length} 個を選択中` : '選択中: なし'}</p>
    {layer && base && shown && group && knobs.length > 0 && <section className="native-thumbnail-knob-group" aria-label={group.title}><h3>{group.title}</h3>
      {knobs.map(knob => knob.kind === 'number'
        ? <ThumbnailNumberKnob key={knob.id} spec={knob} value={knob.read(shown)} disabled={disabled} onLive={value => live(knob.write(base, value))} onCommit={value => void commit(knob.write(base, value))} />
        : <ThumbnailColorKnob key={knob.id} knob={knob} value={knob.read(shown)} disabled={disabled} onLive={value => live(knob.write(base, value))} onCommit={value => void commit(knob.write(base, value))} />)}
    </section>}
    {children}
  </aside>;
}
