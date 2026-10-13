import { describe, expect, it } from 'vitest';
import { slidesFixture } from '../../../core/slides/fixtures';
import { thumbnailViewState, toSlideCommand } from './thumbnailAdapter';

const state = () => ({ sessionId: 's', document: slidesFixture(), savedRevision: 0, savedContentHash: 'h', canUndo: true, canRedo: false, dirty: false, pageHashes: { 'page-1': 'a', 'page-2': 'b' } });

describe('サムネの部品への見せ方', () => {
  it('スライドの 1 ページを、案 1 つだけのサムネ文書（1920×1080・レイヤーはそのまま）として見せる', () => {
    const view = thumbnailViewState(state(), 'page-2');
    expect(view.document.canvas).toEqual({ width: 1920, height: 1080 });
    expect(view.document.pages.map(page => page.id)).toEqual(['page-2']);
    expect(view.document.pages[0]!.layers).toEqual(slidesFixture().pages[1]!.layers);
    expect([view.sessionId, view.canUndo, view.dirty]).toEqual(['s', true, false]);
  });
  it('レイヤーの 5 つの操作と元に戻す・やり直しはそのまま送り、案の操作は通さない', () => {
    expect(toSlideCommand({ type: 'update-layer', pageId: 'page-2', layerId: 'x', patch: { name: '名前' } })).toEqual({ type: 'update-layer', pageId: 'page-2', layerId: 'x', patch: { name: '名前' } });
    expect(toSlideCommand({ type: 'batch', commands: [{ type: 'delete-layers', pageId: 'p', layerIds: ['a'] }, { type: 'reorder-layer', pageId: 'p', layerId: 'b', index: 0 }] }))
      .toEqual({ type: 'batch', commands: [{ type: 'delete-layers', pageId: 'p', layerIds: ['a'] }, { type: 'reorder-layer', pageId: 'p', layerId: 'b', index: 0 }] });
    expect(toSlideCommand({ type: 'undo' })).toEqual({ type: 'undo' });
    expect(toSlideCommand({ type: 'add-page', pageId: 'p', name: '案B' })).toBeNull();
    expect(toSlideCommand({ type: 'batch', commands: [{ type: 'shift-page-hue', pageId: 'p', degrees: 10 }] })).toBeNull();
  });
});
