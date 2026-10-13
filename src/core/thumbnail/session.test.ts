import { describe, expect, it } from 'vitest';
import { textLayer, thumbnailFixture } from './fixtures';
import { ThumbnailSession, type ThumbnailEditRequest } from './session';

const request = (session: ThumbnailSession, executionId: string, command: ThumbnailEditRequest['command']): ThumbnailEditRequest =>
  ({ sessionId: session.id, expectedRevision: session.document.revision, executionId, command });

describe('ThumbnailSession', () => {
  it('実行・元に戻す・やり直しで版が進み、案をまたいで 1 本の履歴になる', () => {
    const session = new ThumbnailSession('s', thumbnailFixture());
    session.execute(request(session, 'a', { type: 'add-page', pageId: 'page-b', name: '案B' }));
    session.execute(request(session, 'b', { type: 'add-layer', pageId: 'page-b', layer: textLayer('b-title') }));
    expect(session.document.revision).toBe(2);
    session.execute(request(session, 'c', { type: 'undo' }));
    expect(session.document.pages[1]!.layers).toEqual([]);
    session.execute(request(session, 'd', { type: 'undo' }));
    expect(session.document.pages).toHaveLength(1);
    session.execute(request(session, 'e', { type: 'redo' }));
    expect(session.document).toMatchObject({ revision: 5 });
    expect(session.document.pages).toHaveLength(2);
  });
  it('同じ実行 ID の再送は再実行しない。中身が違えば断る', () => {
    const session = new ThumbnailSession('s', thumbnailFixture());
    const first = request(session, 'same', { type: 'set-layer-flags', pageId: 'page-a', layerId: 'title', hidden: true });
    session.execute(first);
    const replay = session.execute(first);
    expect(replay).toMatchObject({ replayed: true, appliedRevision: 1 });
    expect(session.document.revision).toBe(1);
    expect(() => session.execute({ ...first, command: { type: 'set-layer-flags', pageId: 'page-a', layerId: 'title', hidden: false } })).toThrow('同じ実行IDに異なる編集内容があります');
  });
  it('拒否した操作は文書・履歴・実行記録を変えない（作成・適用・Undo の各経路）', () => {
    const tooMany = thumbnailFixture();
    for (const id of ['b', 'c', 'd']) tooMany.pages.push({ id, name: id, hueShift: 0, layers: [] });
    expect(() => new ThumbnailSession('s', tooMany)).toThrow('案は 1〜3 つです');

    const session = new ThumbnailSession('s', thumbnailFixture()), before = session.document;
    expect(() => session.execute(request(session, 'bad', { type: 'update-layer', pageId: 'page-a', layerId: 'title', patch: { visual: { ...before.pages[0]!.layers[2]!.visual, opacity: 2 } } }))).toThrow('レイヤーの配置が不正です');
    expect(session.document).toEqual(before);
    expect([session.canUndo, session.canRedo, session.hasExecution('bad')]).toEqual([false, false, false]);

    const edge = thumbnailFixture(); edge.revision = Number.MAX_SAFE_INTEGER - 1;
    const last = new ThumbnailSession('s', edge);
    last.execute(request(last, 'ok', { type: 'set-layer-flags', pageId: 'page-a', layerId: 'title', locked: true }));
    const atLimit = last.document;
    expect(() => last.execute(request(last, 'undo', { type: 'undo' }))).toThrow('サムネの版が不正です');
    expect(last.document).toEqual(atLimit);
    expect([last.canUndo, last.canRedo, last.hasExecution('undo')]).toEqual([true, false, false]);
  });
  it('別のセッションや古い版への操作は断る', () => {
    const session = new ThumbnailSession('s', thumbnailFixture());
    expect(() => session.execute({ ...request(session, 'x', { type: 'undo' }), sessionId: 'other' })).toThrow('別の編集セッションへの操作です');
    expect(() => session.execute({ ...request(session, 'y', { type: 'undo' }), expectedRevision: 7 })).toThrow('編集内容が更新されています');
  });
});
