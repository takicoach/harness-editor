import { describe, it, expect } from 'vitest';
import { tabForSelection, selectionWantsSettings, selectionIsSubtitle } from './dockTab';
import type { EditState } from './edit/editState';

// 必要最小のダミー state（型を満たすため unknown 経由）。
function mk(selection: EditState['selection'], telops: Array<{ id: number; manual?: boolean }> = []): EditState {
  return { selection, telops } as unknown as EditState;
}

describe('selectionWantsSettings', () => {
  it('未選択は false', () => expect(selectionWantsSettings(mk(null))).toBe(false));
  it('字幕(manual でない telop)は false', () =>
    expect(selectionWantsSettings(mk({ kind: 'telop', id: 1 }, [{ id: 1, manual: false }]))).toBe(false));
  it('装飾 telop(manual:true)は true', () =>
    expect(selectionWantsSettings(mk({ kind: 'telop', id: 1 }, [{ id: 1, manual: true }]))).toBe(true));
  it('bgm/se/image/videoInsert/title は true', () => {
    for (const kind of ['bgm', 'se', 'image', 'videoInsert', 'title'] as const) {
      expect(selectionWantsSettings(mk({ kind, id: 1 }))).toBe(true);
    }
  });
  it('stale な telop 選択は false', () =>
    expect(selectionWantsSettings(mk({ kind: 'telop', id: 99 }, [{ id: 1, manual: true }]))).toBe(false));
});

describe('selectionIsSubtitle', () => {
  it('字幕 telop は true', () =>
    expect(selectionIsSubtitle(mk({ kind: 'telop', id: 1 }, [{ id: 1, manual: false }]))).toBe(true));
  it('装飾 telop は false', () =>
    expect(selectionIsSubtitle(mk({ kind: 'telop', id: 1 }, [{ id: 1, manual: true }]))).toBe(false));
  it('bgm は false', () => expect(selectionIsSubtitle(mk({ kind: 'bgm', id: 1 }))).toBe(false));
  it('未選択は false', () => expect(selectionIsSubtitle(mk(null))).toBe(false));
});

describe('tabForSelection', () => {
  it('未選択は null（タブ変更なし）', () => expect(tabForSelection(mk(null))).toBeNull());
  it('設定対象クリップは settings', () => {
    expect(tabForSelection(mk({ kind: 'bgm', id: 1 }))).toBe('settings');
    expect(tabForSelection(mk({ kind: 'image', id: 1 }))).toBe('settings');
    expect(tabForSelection(mk({ kind: 'telop', id: 1 }, [{ id: 1, manual: true }]))).toBe('settings');
  });
  it('字幕は transcript', () =>
    expect(tabForSelection(mk({ kind: 'telop', id: 1 }, [{ id: 1, manual: false }]))).toBe('transcript'));
  it('cutSegment は settings タブ', () =>
    expect(tabForSelection(mk({ kind: 'cutSegment', id: 1 }))).toBe('settings'));
});
