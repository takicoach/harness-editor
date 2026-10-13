import { boxExtent, unionBox, type LayerBox } from './canvasMath';
import { deleteSelection, duplicateSelection, isEditable, reorderSelection } from './layerActions';
import { ThumbnailMenuButton } from './ThumbnailMenuButton';
import type { ThumbnailEditor } from './useThumbnailEditor';

/** 選択枠の上の小メニュー。動かしている間（一時表示がある間）と文字の編集中は隠す。 */
export function ThumbnailMiniMenu({ editor }: { editor: ThumbnailEditor }) {
  const layers = editor.page.layers.filter(layer => editor.selected.includes(layer.id));
  const boxes = layers.map(layer => editor.boxes.get(layer.id)).filter((box): box is LayerBox => !!box);
  if (!layers.length || !boxes.length || editor.editingText || editor.overrides.size) return null;
  const extent = boxExtent(unionBox(boxes)), scale = editor.scale, above = extent.top * scale >= 44, locked = layers.every(layer => !isEditable(layer));
  const toggleLock = () => {
    const commands = layers.map(layer => ({ type: 'set-layer-flags' as const, pageId: editor.pageId, layerId: layer.id, locked: !locked }));
    void editor.execute(commands.length === 1 ? commands[0]! : { type: 'batch', commands });
  };
  return <div className="native-thumbnail-minimenu" role="toolbar" aria-label="選んだ物のメニュー" data-side={above ? 'above' : 'below'}
    style={{ left: (extent.left + extent.right) / 2 * scale, top: (above ? extent.top : extent.bottom) * scale }}
    onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}>
    <button type="button" className="btn-ghost" disabled={editor.disabled} onClick={() => void duplicateSelection(editor)}>複製</button>
    <button type="button" className="btn-ghost" disabled={editor.disabled} onClick={toggleLock}>{locked ? 'ロック解除' : 'ロック'}</button>
    <button type="button" className="btn-ghost" disabled={editor.disabled || locked} onClick={() => void deleteSelection(editor)}>削除</button>
    <ThumbnailMenuButton label="その他" disabled={editor.disabled} items={[
      { label: '前面へ', run: () => void reorderSelection(editor, 1), disabled: layers.length !== 1 },
      { label: '背面へ', run: () => void reorderSelection(editor, -1), disabled: layers.length !== 1 },
      { label: 'つまみを開く', run: editor.openKnobs }]} />
  </div>;
}
