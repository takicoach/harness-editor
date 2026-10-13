import type { ReactNode } from 'react';
import { Icon } from '../../Icon';
import { knobGroupFor, resetCommand, type KnobValue } from './knobs';
import { ThumbnailColorKnob, ThumbnailNumberKnob } from './ThumbnailKnob';
import { ThumbnailPageKnobs } from './ThumbnailPageKnobs';
import type { ThumbnailEditor } from './useThumbnailEditor';

/** 右のつまみ（常設・畳める）。上に「選択中」の札、選んだ物のつまみ、下に「サムネ全体」。畳んだ細い列には closedTop（「AI に頼む」の入口）だけを残す。 */
export function ThumbnailKnobsPanel({ editor, open, onOpen, top, closedTop }: { editor: ThumbnailEditor; open: boolean; onOpen(open: boolean): void; top?: ReactNode; closedTop?: ReactNode }) {
  const layer = editor.selected.length === 1 ? editor.page.layers.find(item => item.id === editor.selected[0]) : undefined;
  if (!open) return <aside className="native-thumbnail-knobs" aria-label="つまみ">
    <button type="button" className="btn-ghost native-header-icon" aria-label="つまみを開く" title="つまみを開く" onClick={() => onOpen(true)}><Icon name="sliders" /></button>{closedTop}</aside>;
  const base: KnobValue | null = layer ? { visual: layer.visual, content: layer.content } : null;
  const override = layer ? editor.overrides.get(layer.id) : undefined;
  const shown: KnobValue | null = base ? { visual: override?.visual ?? base.visual, content: override?.content ?? base.content } : null;
  const live = (next: KnobValue) => { if (layer) editor.setOverrides(new Map([[layer.id, next]])); };
  const commit = async (next: KnobValue) => {
    if (!layer || !base) return;
    if (JSON.stringify(next) !== JSON.stringify(base)) await editor.updateLayers([{ layerId: layer.id, patch: { visual: next.visual, content: next.content } }]);
    editor.setOverrides(null);
  };
  const group = layer ? knobGroupFor(layer) : null, disabled = editor.disabled || !!layer?.locked;
  // 選んだ物のつまみとサムネ全体のつまみを 1 回の操作（元に戻す 1 回）で戻す。何も選んでいない時はサムネ全体だけ。
  const reset = async () => {
    const command = resetCommand(editor.page, layer);
    if (command) await editor.execute(command);
    editor.setOverrides(null);
  };
  return <aside className="native-thumbnail-knobs" aria-label="つまみ">
    <header className="native-thumbnail-knobs-head"><strong>つまみ</strong>
      <button type="button" className="btn-ghost" disabled={editor.disabled} title={layer && !layer.locked ? '選んだ物とサムネ全体のつまみを初期値に戻します' : 'サムネ全体のつまみ（文字側の暗さ・色の組み合わせ）を初期値に戻します。ロック中の物は戻しません'}
        onClick={() => void reset()}>初期値に戻す</button>
      <button type="button" className="btn-ghost native-header-icon" aria-label="つまみを畳む" title="つまみを畳む" onClick={() => onOpen(false)}><Icon name="chevron-right" /></button></header>
    {top}
    <p className="native-thumbnail-chip">{layer ? `選択中: ${layer.name}${layer.locked ? '（ロック中）' : ''}` : editor.selected.length > 1 ? `${editor.selected.length} 個を選択中` : '選択中: なし'}</p>
    {layer && base && shown && group && group.knobs.length > 0 && <section className="native-thumbnail-knob-group" aria-label={group.title}><h3>{group.title}</h3>
      {group.knobs.map(knob => knob.kind === 'number'
        ? <ThumbnailNumberKnob key={knob.id} spec={knob} value={knob.read(shown)} disabled={disabled} onLive={value => live(knob.write(base, value))} onCommit={value => void commit(knob.write(base, value))} />
        : <ThumbnailColorKnob key={knob.id} knob={knob} value={knob.read(shown)} disabled={disabled} onLive={value => live(knob.write(base, value))} onCommit={value => void commit(knob.write(base, value))} />)}
    </section>}
    <ThumbnailPageKnobs editor={editor} />
  </aside>;
}
