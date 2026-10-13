import { describe, expect, it } from 'vitest';
import { slidesFixture } from './fixtures';
import { SlideSession, type SlideEditRequest } from './session';

const request = (session: SlideSession, executionId: string, command: SlideEditRequest['command']): SlideEditRequest =>
  ({ sessionId: session.id, expectedRevision: session.document.revision, executionId, command });

describe('SlideSession', () => {
  it('ページをまたいで 1 本の Undo/Redo', () => {
    const session = new SlideSession('s', slidesFixture());
    session.execute(request(session, 'a', { type: 'add-page', pageId: 'page-3', layout: 'points' }));
    session.execute(request(session, 'b', { type: 'set-notes', pageId: 'page-1', notes: '挨拶' }));
    expect(session.document.revision).toBe(2);
    session.execute(request(session, 'c', { type: 'undo' }));
    expect(session.document.pages[0]!.notes).toBe('');
    session.execute(request(session, 'd', { type: 'undo' }));
    expect(session.document.pages).toHaveLength(2);
    session.execute(request(session, 'e', { type: 'redo' }));
    expect(session.document).toMatchObject({ revision: 5 });
    expect(session.document.pages).toHaveLength(3);
  });
  it('同じ実行 ID の再送は再実行しない。中身が違えば断る', () => {
    const session = new SlideSession('s', slidesFixture()), first = request(session, 'same', { type: 'set-notes', pageId: 'page-1', notes: '一回目' });
    session.execute(first);
    expect(session.execute(first)).toMatchObject({ replayed: true, appliedRevision: 1 });
    expect(session.document.revision).toBe(1);
    expect(() => session.execute({ ...first, command: { type: 'set-notes', pageId: 'page-1', notes: '別' } })).toThrow('同じ実行IDに異なる編集内容があります');
  });
  it('版が古い要求は断る（人の編集と AI が衝突したとき）', () => {
    const session = new SlideSession('s', slidesFixture());
    session.execute(request(session, 'human', { type: 'set-notes', pageId: 'page-1', notes: '人' }));
    expect(() => session.execute({ sessionId: 's', expectedRevision: 0, executionId: 'ai', command: { type: 'set-notes', pageId: 'page-1', notes: 'AI' } }))
      .toThrow('編集内容が更新されています');
    expect(session.document.pages[0]!.notes).toBe('人');
  });
  it('拒否した操作は文書・履歴・実行記録を変えない。壊れた文書ではセッションを作らない', () => {
    const session = new SlideSession('s', slidesFixture()), before = session.document;
    expect(() => session.execute(request(session, 'bad', { type: 'set-notes', pageId: 'page-1', notes: 'あ'.repeat(2001) }))).toThrow('話すメモは 2000 文字までです');
    expect(session.document).toEqual(before);
    expect([session.canUndo, session.canRedo, session.hasExecution('bad')]).toEqual([false, false, false]);
    expect(() => new SlideSession('s', { ...slidesFixture(), canvas: { width: 1, height: 1 } })).toThrow('キャンバスの大きさが不正です');
  });
});
