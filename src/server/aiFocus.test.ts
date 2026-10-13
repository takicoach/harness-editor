import { describe, expect, it } from 'vitest';
import type { AiScreen } from '../shared/aiFocus';
import { AiFocusRegistry } from './aiFocus';

const screen = (projectId: string, mode: AiScreen['mode'] = 'video'): AiScreen => ({ projectId, projectName: `名前-${projectId}`, mode,
  target: mode === 'video' ? { kind: 'video', editorSessionId: `w-${projectId}` } : null, playheadSec: null, selection: [], materials: '' });
function clock() { let now = 1000; return { now: () => now, advance: (ms: number) => { now += ms; } }; }

describe('主画面の台帳', () => {
  it('AI タブを開いた画面（claim）が主画面になり、別の画面が開けば移る。定期報告（beat）では移らない', () => {
    const time = clock(), registry = new AiFocusRegistry(time.now, 15000);
    registry.claim({ pageId: 'page-aaaa', seq: 1, screen: screen('a') });
    expect(registry.beat({ pageId: 'page-bbbb', seq: 1, screen: screen('b') })).toEqual({ primary: false });
    expect(registry.primary()).toMatchObject({ pageId: 'page-aaaa', screen: { projectId: 'a' } });
    registry.claim({ pageId: 'page-bbbb', seq: 2, screen: screen('b', 'slides') });
    expect(registry.primary()).toMatchObject({ pageId: 'page-bbbb', screen: { projectId: 'b', mode: 'slides' } });
  });
  it('古い連番の報告は捨てる（StrictMode の二重実行で順序が入れ替わっても戻らない）', () => {
    const registry = new AiFocusRegistry(clock().now, 15000);
    registry.claim({ pageId: 'page-aaaa', seq: 5, screen: screen('b') });
    registry.beat({ pageId: 'page-aaaa', seq: 4, screen: null });
    expect(registry.primary()?.screen?.projectId).toBe('b');
    registry.beat({ pageId: 'page-aaaa', seq: 6, screen: screen('c', 'thumbnail') });
    expect(registry.primary()?.screen).toMatchObject({ projectId: 'c', mode: 'thumbnail' });
  });
  it('閉じた画面（release）と、15 秒報告の無い画面は主画面でなくなる', () => {
    const time = clock(), registry = new AiFocusRegistry(time.now, 15000);
    registry.claim({ pageId: 'page-aaaa', seq: 1, screen: screen('a') });
    registry.release('page-aaaa');
    expect(registry.primary()).toBeNull();
    registry.claim({ pageId: 'page-bbbb', seq: 1, screen: screen('b') });
    time.advance(14999);
    expect(registry.primary()?.pageId).toBe('page-bbbb');
    time.advance(1);
    expect(registry.primary()).toBeNull();
  });
  it('送信（Enter）の時の主画面の状況を依頼時点として残す。主画面が無ければ依頼時点は無い', () => {
    const time = clock(), registry = new AiFocusRegistry(time.now, 15000);
    expect(registry.noteSubmit()).toBeNull();
    registry.claim({ pageId: 'page-aaaa', seq: 1, screen: screen('a') });
    expect(registry.noteSubmit()).toEqual({ projectId: 'a', projectName: '名前-a', mode: 'video', at: 1000 });
    registry.beat({ pageId: 'page-aaaa', seq: 2, screen: screen('b') });
    expect(registry.request()?.projectId).toBe('a');
    registry.beat({ pageId: 'page-aaaa', seq: 3, screen: null });
    expect(registry.noteSubmit()).toBeNull();
  });
  it('書き込みの対象確認: 依頼時点が無い・別の案件は断り、同じ案件ならモードが違っても通す', () => {
    const registry = new AiFocusRegistry(clock().now, 15000);
    expect(registry.checkWriteTarget('a')).toMatchObject({ code: 'TARGET_NOT_REQUESTED' });
    registry.claim({ pageId: 'page-aaaa', seq: 1, screen: screen('a') });
    registry.noteSubmit();
    registry.beat({ pageId: 'page-aaaa', seq: 2, screen: screen('a', 'thumbnail') });
    expect(registry.checkWriteTarget('a')).toBeNull();
    const denied = registry.checkWriteTarget('b');
    expect(denied).toMatchObject({ code: 'TARGET_NOT_REQUESTED' });
    expect(denied?.message).toContain('名前-a');
    expect(denied?.recovery).toContain('利用者に確かめて');
  });
  it('AI が最後に確認した状況（editor_context を呼んだ時の主画面）を覚える', () => {
    const time = clock(), registry = new AiFocusRegistry(time.now, 15000);
    registry.claim({ pageId: 'page-aaaa', seq: 1, screen: screen('a', 'slides') });
    time.advance(500);
    registry.noteContextRead();
    expect(registry.view()).toMatchObject({ primary: { pageId: 'page-aaaa' }, request: null,
      lastRead: { projectId: 'a', projectName: '名前-a', mode: 'slides', at: 1500 } });
  });
  it('形の違う報告は例外にする（口で 400 にする）', () => {
    const registry = new AiFocusRegistry(clock().now, 15000);
    expect(() => registry.beat({ pageId: 'page-aaaa', seq: 1, screen: { projectId: 'a' } })).toThrow();
  });
});
