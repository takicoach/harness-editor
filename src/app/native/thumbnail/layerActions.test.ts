import { describe, expect, it, vi } from 'vitest';
import { shapeLayer } from '../../../core/thumbnail/fixtures';
import type { ThumbnailLayer } from '../../../core/thumbnail/model';
import { deleteSelection, isEditable, LOCKED_MESSAGE } from './layerActions';
import type { ThumbnailEditor } from './useThumbnailEditor';

function editorWith(layers: ThumbnailLayer[], selected: string[]) {
  const execute = vi.fn(async () => true), toast = vi.fn();
  // 操作関数が読む項目だけを持つ見本（画面の状態フックは使わない）。
  const editor = { page: { id: 'p', name: '案A', hueShift: 0, layers }, pageId: 'p', selected, execute, toast } as unknown as ThumbnailEditor;
  return { editor, execute, toast };
}
describe('ロック', () => {
  it('ロック中は編集できない', () => {
    expect(isEditable({ ...shapeLayer('a'), locked: true })).toBe(false);
    expect(isEditable(shapeLayer('a'))).toBe(true);
  });
  it('削除はロック中を除く。全部ロック中なら消さずに知らせる', async () => {
    const both = editorWith([{ ...shapeLayer('a'), locked: true }, shapeLayer('b')], ['a', 'b']);
    await deleteSelection(both.editor);
    expect(both.execute).toHaveBeenCalledWith({ type: 'delete-layers', pageId: 'p', layerIds: ['b'] });
    const locked = editorWith([{ ...shapeLayer('a'), locked: true }], ['a']);
    expect(await deleteSelection(locked.editor)).toBe(false);
    expect(locked.execute).not.toHaveBeenCalled();
    expect(locked.toast).toHaveBeenCalledWith(LOCKED_MESSAGE);
  });
});
