// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';
import { shapeLayer } from '../../../core/thumbnail/fixtures';
import type { ThumbnailLayer } from '../../../core/thumbnail/model';
import { LOCKED_MESSAGE } from './layerActions';
import { useCanvasKeys } from './useCanvasKeys';
import type { ThumbnailEditor } from './useThumbnailEditor';

function editorWith(layers: ThumbnailLayer[], selected: string[]) {
  const execute = vi.fn(async () => true), updateLayers = vi.fn(async () => true), toast = vi.fn();
  // キー操作が読む項目だけを持つ見本（画面の状態フックは使わない）。
  const editor = { page: { id: 'p', name: '案A', hueShift: 0, layers }, pageId: 'p', selected, execute, updateLayers, toast, disabled: false, editingText: null,
    session: { busy: false }, document: { canvas: { width: 1280, height: 720 } }, select: vi.fn(), setEditingText: vi.fn() } as unknown as ThumbnailEditor;
  return { editor, execute, updateLayers, toast };
}
const press = (target: EventTarget, key: string) => target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
afterEach(() => { cleanup(); document.body.innerHTML = ''; });

describe('キャンバスのキー操作', () => {
  it('ボタン・リンクにフォーカスがある時の Delete / Backspace では選んだレイヤーを消さない（Enter と同じ除外）', () => {
    const { editor, execute } = editorWith([shapeLayer('a')], ['a']);
    renderHook(() => useCanvasKeys(editor));
    const button = document.body.appendChild(document.createElement('button')), link = document.body.appendChild(document.createElement('a'));
    button.focus();
    press(button, 'Delete'); press(button, 'Backspace'); press(link, 'Delete');
    expect(execute).not.toHaveBeenCalled();
    press(document.body, 'Delete');
    expect(execute).toHaveBeenCalledWith({ type: 'delete-layers', pageId: 'p', layerIds: ['a'] });
  });
  it('レイヤー一覧の行ボタン（選択の入口）にフォーカスがあっても、Delete で選んだレイヤーを消す', () => {
    const { editor, execute } = editorWith([shapeLayer('a')], ['a']);
    renderHook(() => useCanvasKeys(editor));
    const row = document.body.appendChild(document.createElement('button'));
    row.setAttribute('data-layer-select', '');
    row.focus();
    press(row, 'Delete');
    expect(execute).toHaveBeenCalledWith({ type: 'delete-layers', pageId: 'p', layerIds: ['a'] });
  });
  it('ロック中に矢印を押しっぱなしにしても、知らせはキーのリピートごとに出し直さない', () => {
    const { editor, toast } = editorWith([{ ...shapeLayer('a'), locked: true }], ['a']);
    renderHook(() => useCanvasKeys(editor));
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    for (let i = 0; i < 3; i++) document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', repeat: true, bubbles: true, cancelable: true }));
    expect(toast).toHaveBeenCalledTimes(1);
  });
  it('ロック中の物を矢印で動かそうとしたら、削除と同じ「ロック中」の知らせを出し、動かさない', () => {
    const locked = editorWith([{ ...shapeLayer('a'), locked: true }], ['a']);
    renderHook(() => useCanvasKeys(locked.editor));
    press(document.body, 'ArrowRight');
    expect(locked.toast).toHaveBeenCalledWith(LOCKED_MESSAGE);
    expect(locked.updateLayers).not.toHaveBeenCalled();
  });
  it('ロックしていない物が混ざっていれば、その物だけを動かす（知らせは出さない）', () => {
    const mixed = editorWith([{ ...shapeLayer('a'), locked: true }, shapeLayer('b')], ['a', 'b']);
    renderHook(() => useCanvasKeys(mixed.editor));
    press(document.body, 'ArrowLeft');
    expect(mixed.toast).not.toHaveBeenCalled();
    expect(mixed.updateLayers).toHaveBeenCalledTimes(1);
    expect((mixed.updateLayers.mock.calls[0] as unknown as [Array<{ layerId: string }>])[0].map(change => change.layerId)).toEqual(['b']);
  });
});
