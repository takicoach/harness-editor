import { THUMBNAIL_MAX_LAYERS, type ThumbnailLayer } from '../../../core/thumbnail/model';
import { movedVisual } from './canvasMath';
import { duplicateOf } from './layerFactory';
import type { ThumbnailEditor } from './useThumbnailEditor';

export const LOCKED_MESSAGE = 'ロック中のレイヤーは動かしたり消したりできません。ロックを外してから操作してください';
/** ロック中は選べるが、動かす・拡縮・回転・文字・削除・つまみはできない（表示・重なり順・ロック・複製はできる）。 */
export function isEditable(layer: ThumbnailLayer): boolean { return !layer.locked; }

/** 選んだレイヤーを最前面に複製する（1 回の操作）。 */
export async function duplicateSelection(editor: ThumbnailEditor): Promise<boolean> {
  const layers = editor.page.layers.filter(layer => editor.selected.includes(layer.id));
  if (!layers.length) return false;
  if (editor.page.layers.length + layers.length > THUMBNAIL_MAX_LAYERS) { editor.toast(`1 つの案に置けるレイヤーは ${THUMBNAIL_MAX_LAYERS} までです`); return false; }
  const copies = layers.map(layer => duplicateOf(layer, editor.newLayerId(), editor.document.canvas));
  const commands = copies.map(copy => ({ type: 'add-layer' as const, pageId: editor.pageId, layer: copy }));
  const ok = await editor.execute(commands.length === 1 ? commands[0]! : { type: 'batch', commands });
  if (ok) editor.select(copies.map(copy => copy.id));
  return ok;
}
export function deleteSelection(editor: ThumbnailEditor): Promise<boolean> {
  const chosen = editor.page.layers.filter(layer => editor.selected.includes(layer.id)), ids = chosen.filter(isEditable).map(layer => layer.id);
  if (chosen.length && !ids.length) editor.toast(LOCKED_MESSAGE);
  return ids.length ? editor.execute({ type: 'delete-layers', pageId: editor.pageId, layerIds: ids }) : Promise.resolve(false);
}
/** 矢印キーの 1 歩（キャンバスの px）。ロック中は動かさない。全部ロック中なら削除と同じく知らせる。 */
export function moveSelection(editor: ThumbnailEditor, dx: number, dy: number, notify = true): Promise<boolean> {
  const chosen = editor.page.layers.filter(layer => editor.selected.includes(layer.id)), movable = chosen.filter(isEditable);
  if (notify && chosen.length && !movable.length) editor.toast(LOCKED_MESSAGE);
  return movable.length ? editor.updateLayers(movable.map(layer => ({ layerId: layer.id, patch: { visual: movedVisual(layer, dx, dy, editor.document.canvas) } }))) : Promise.resolve(false);
}
/** 1 つ選んでいるときだけ、前面（+1）・背面（-1）へ 1 段動かす。 */
export function reorderSelection(editor: ThumbnailEditor, step: 1 | -1): Promise<boolean> {
  if (editor.selected.length !== 1) return Promise.resolve(false);
  const layerId = editor.selected[0]!, index = editor.page.layers.findIndex(layer => layer.id === layerId), next = index + step;
  if (index < 0 || next < 0 || next >= editor.page.layers.length) return Promise.resolve(false);
  return editor.execute({ type: 'reorder-layer', pageId: editor.pageId, layerId, index: next });
}
