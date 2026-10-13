import { useState } from 'react';
import { Icon } from '../../Icon';
import type { ThumbnailEditor } from './useThumbnailEditor';

/** 今の案の重なり順（上が前面）。ドラッグで並べ替え、表示、ロック。どれもこの案のレイヤーだけに効く。 */
export function ThumbnailLayers({ editor }: { editor: ThumbnailEditor }) {
  const { page } = editor, [dragged, setDragged] = useState<string | null>(null);
  const indexOf = (id: string) => page.layers.findIndex(layer => layer.id === id);
  const move = (id: string, index: number) => {
    if (index < 0 || index >= page.layers.length || index === indexOf(id)) return;
    void editor.execute({ type: 'reorder-layer', pageId: page.id, layerId: id, index });
  };
  if (!page.layers.length) return <p className="native-thumbnail-note">まだレイヤーがありません。テキストや画像を足してください。</p>;
  return <ol className="native-thumbnail-layers" aria-label="重なり順（上が前面）">
    {[...page.layers].reverse().map(layer => <li key={layer.id} className="native-thumbnail-layer" draggable={!editor.disabled}
      data-selected={editor.selected.includes(layer.id) ? 'true' : undefined}
      onDragStart={event => { setDragged(layer.id); event.dataTransfer.effectAllowed = 'move'; }}
      onDragOver={event => event.preventDefault()}
      onDrop={event => { event.preventDefault(); if (dragged) move(dragged, indexOf(layer.id)); setDragged(null); }}>
      <button type="button" data-layer-select="" className="btn-ghost native-thumbnail-layer-name" aria-pressed={editor.selected.includes(layer.id)} onClick={() => editor.select([layer.id])}>{layer.name}</button>
      <button type="button" className="btn-ghost native-header-icon" aria-label={layer.hidden ? `${layer.name}を表示` : `${layer.name}を隠す`} disabled={editor.disabled}
        onClick={() => void editor.execute({ type: 'set-layer-flags', pageId: page.id, layerId: layer.id, hidden: !layer.hidden })}><Icon name={layer.hidden ? 'eye-off' : 'eye'} /></button>
      <button type="button" className="native-toggle native-thumbnail-lock" aria-pressed={layer.locked} aria-label={layer.locked ? `${layer.name}のロックを外す` : `${layer.name}をロック`}
        disabled={editor.disabled} onClick={() => void editor.execute({ type: 'set-layer-flags', pageId: page.id, layerId: layer.id, locked: !layer.locked })}>{layer.locked ? 'ロック中' : 'ロック'}</button>
      <button type="button" className="btn-ghost native-header-icon" aria-label={`${layer.name}を前面へ`} disabled={editor.disabled || indexOf(layer.id) === page.layers.length - 1}
        onClick={() => move(layer.id, indexOf(layer.id) + 1)}><Icon name="arrow-up" /></button>
      <button type="button" className="btn-ghost native-header-icon" aria-label={`${layer.name}を背面へ`} disabled={editor.disabled || indexOf(layer.id) === 0}
        onClick={() => move(layer.id, indexOf(layer.id) - 1)}><Icon name="arrow-down" /></button>
    </li>)}
  </ol>;
}
